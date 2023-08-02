const Path = require('path')
const fs = require('../libs/fsExtra')
const filePerms = require('../utils/filePerms')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Library = require('../objects/Library')
const libraryHelpers = require('../utils/libraryHelpers')
const { sort, createNewSortInstance } = require('../libs/fastSort')
const naturalSort = createNewSortInstance({
  comparer: new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare
})

const Database = require('../Database')

class LibraryController {
  constructor() { }

  async create(req, res) {
    const newLibraryPayload = {
      ...req.body
    }
    if (!newLibraryPayload.name || !newLibraryPayload.folders || !newLibraryPayload.folders.length) {
      return res.status(500).send('Invalid request')
    }

    // Validate folder paths exist or can be created & resolve rel paths
    //   returns 400 if a folder fails to access
    newLibraryPayload.folders = newLibraryPayload.folders.map(f => {
      f.fullPath = Path.resolve(f.fullPath)
      return f
    })
    for (const folder of newLibraryPayload.folders) {
      try {
        const direxists = await fs.pathExists(folder.fullPath)
        if (!direxists) { // If folder does not exist try to make it and set file permissions/owner
          await fs.mkdir(folder.fullPath)
          await filePerms.setDefault(folder.fullPath)
        }
      } catch (error) {
        Logger.error(`[LibraryController] Failed to ensure folder dir "${folder.fullPath}"`, error)
        return res.status(400).send(`Invalid folder directory "${folder.fullPath}"`)
      }
    }

    const library = new Library()

    let currentLargestDisplayOrder = await Database.models.library.getMaxDisplayOrder()
    if (isNaN(currentLargestDisplayOrder)) currentLargestDisplayOrder = 0
    newLibraryPayload.displayOrder = currentLargestDisplayOrder + 1
    library.setData(newLibraryPayload)
    await Database.createLibrary(library)

    // Only emit to users with access to library
    const userFilter = (user) => {
      return user.checkCanAccessLibrary?.(library.id)
    }
    SocketAuthority.emitter('library_added', library.toJSON(), userFilter)

    // Add library watcher
    this.watcher.addLibrary(library)

    res.json(library)
  }

  async findAll(req, res) {
    const libraries = await Database.models.library.getAllOldLibraries()

    const librariesAccessible = req.user.librariesAccessible || []
    if (librariesAccessible.length) {
      return res.json({
        libraries: libraries.filter(lib => librariesAccessible.includes(lib.id)).map(lib => lib.toJSON())
      })
    }

    res.json({
      libraries: libraries.map(lib => lib.toJSON())
    })
  }

  async findOne(req, res) {
    const includeArray = (req.query.include || '').split(',')
    if (includeArray.includes('filterdata')) {
      return res.json({
        filterdata: libraryHelpers.getDistinctFilterDataNew(req.libraryItems),
        issues: req.libraryItems.filter(li => li.hasIssues).length,
        numUserPlaylists: await Database.models.playlist.getNumPlaylistsForUserAndLibrary(req.user.id, req.library.id),
        library: req.library
      })
    }
    return res.json(req.library)
  }

  async getEpisodeDownloadQueue(req, res) {
    const libraryDownloadQueueDetails = this.podcastManager.getDownloadQueueDetails(req.library.id)
    return res.json(libraryDownloadQueueDetails)
  }

  async update(req, res) {
    const library = req.library

    // Validate new folder paths exist or can be created & resolve rel paths
    //   returns 400 if a new folder fails to access
    if (req.body.folders) {
      const newFolderPaths = []
      req.body.folders = req.body.folders.map(f => {
        if (!f.id) {
          f.fullPath = Path.resolve(f.fullPath)
          newFolderPaths.push(f.fullPath)
        }
        return f
      })
      for (const path of newFolderPaths) {
        const pathExists = await fs.pathExists(path)
        if (!pathExists) {
          // Ensure dir will recursively create directories which might be preferred over mkdir
          const success = await fs.ensureDir(path).then(() => true).catch((error) => {
            Logger.error(`[LibraryController] Failed to ensure folder dir "${path}"`, error)
            return false
          })
          if (!success) {
            return res.status(400).send(`Invalid folder directory "${path}"`)
          }
          // Set permissions on newly created path
          await filePerms.setDefault(path)
        }
      }
    }

    const hasUpdates = library.update(req.body)
    // TODO: Should check if this is an update to folder paths or name only
    if (hasUpdates) {
      // Update watcher
      this.watcher.updateLibrary(library)

      // Update auto scan cron
      this.cronManager.updateLibraryScanCron(library)

      // Remove libraryItems no longer in library
      const itemsToRemove = Database.libraryItems.filter(li => li.libraryId === library.id && !library.checkFullPathInLibrary(li.path))
      if (itemsToRemove.length) {
        Logger.info(`[Scanner] Updating library, removing ${itemsToRemove.length} items`)
        for (let i = 0; i < itemsToRemove.length; i++) {
          await this.handleDeleteLibraryItem(itemsToRemove[i])
        }
      }
      await Database.updateLibrary(library)

      // Only emit to users with access to library
      const userFilter = (user) => {
        return user.checkCanAccessLibrary && user.checkCanAccessLibrary(library.id)
      }
      SocketAuthority.emitter('library_updated', library.toJSON(), userFilter)
    }
    return res.json(library.toJSON())
  }

  /**
   * DELETE: /api/libraries/:id
   * Delete a library
   * @param {*} req 
   * @param {*} res 
   */
  async delete(req, res) {
    const library = req.library

    // Remove library watcher
    this.watcher.removeLibrary(library)

    // Remove collections for library
    const numCollectionsRemoved = await Database.models.collection.removeAllForLibrary(library.id)
    if (numCollectionsRemoved) {
      Logger.info(`[Server] Removed ${numCollectionsRemoved} collections for library "${library.name}"`)
    }

    // Remove items in this library
    const libraryItems = Database.libraryItems.filter(li => li.libraryId === library.id)
    Logger.info(`[Server] deleting library "${library.name}" with ${libraryItems.length} items"`)
    for (let i = 0; i < libraryItems.length; i++) {
      await this.handleDeleteLibraryItem(libraryItems[i])
    }

    const libraryJson = library.toJSON()
    await Database.removeLibrary(library.id)

    // Re-order libraries
    await Database.models.library.resetDisplayOrder()

    SocketAuthority.emitter('library_removed', libraryJson)
    return res.json(libraryJson)
  }

  async getLibraryItemsNew(req, res) {
    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const payload = {
      results: [],
      total: undefined,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0,
      sortBy: req.query.sort,
      sortDesc: req.query.desc === '1',
      filterBy: req.query.filter,
      mediaType: req.library.mediaType,
      minified: req.query.minified === '1',
      collapseseries: req.query.collapseseries === '1',
      include: include.join(',')
    }
    payload.offset = payload.page * payload.limit

    const { libraryItems, count } = await Database.models.libraryItem.getByFilterAndSort(req.library, req.user.id, payload)
    payload.results = libraryItems
    payload.total = count

    res.json(payload)
  }

  // api/libraries/:id/items
  // TODO: Optimize this method, items are iterated through several times but can be combined
  async getLibraryItems(req, res) {
    let libraryItems = req.libraryItems

    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const payload = {
      results: [],
      total: libraryItems.length,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0,
      sortBy: req.query.sort,
      sortDesc: req.query.desc === '1',
      filterBy: req.query.filter,
      mediaType: req.library.mediaType,
      minified: req.query.minified === '1',
      collapseseries: req.query.collapseseries === '1',
      include: include.join(',')
    }
    const mediaIsBook = payload.mediaType === 'book'
    const mediaIsPodcast = payload.mediaType === 'podcast'

    // Step 1 - Filter the retrieved library items
    let filterSeries = null
    if (payload.filterBy) {
      libraryItems = await libraryHelpers.getFilteredLibraryItems(libraryItems, payload.filterBy, req.user)
      payload.total = libraryItems.length

      // Determining if we are filtering titles by a series, and if so, which series
      filterSeries = (mediaIsBook && payload.filterBy.startsWith('series.')) ? libraryHelpers.decode(payload.filterBy.replace('series.', '')) : null
      if (filterSeries === 'no-series') filterSeries = null
    }

    // Step 2 - If selected, collapse library items by the series they belong to.
    // If also filtering by series, will not collapse the filtered series as this would lead
    // to series having a collapsed series that is just that series.
    if (payload.collapseseries) {
      let collapsedItems = libraryHelpers.collapseBookSeries(libraryItems, Database.series, filterSeries, req.library.settings.hideSingleBookSeries)

      if (!(collapsedItems.length == 1 && collapsedItems[0].collapsedSeries)) {
        libraryItems = collapsedItems

        // Get accurate total entities
        // let uniqueEntities = new Set()
        // libraryItems.forEach((item) => {
        //   if (item.collapsedSeries) {
        //     item.collapsedSeries.books.forEach(book => uniqueEntities.add(book.id))
        //   } else {
        //     uniqueEntities.add(item.id)
        //   }
        // })
        payload.total = libraryItems.length
      }
    }

    // Step 3 - Sort the retrieved library items.
    const sortArray = []

    // When on the series page, sort by sequence only
    if (filterSeries && !payload.sortBy) {
      sortArray.push({ asc: (li) => li.media.metadata.getSeries(filterSeries).sequence })
      // If no series sequence then fallback to sorting by title (or collapsed series name for sub-series)
      sortArray.push({
        asc: (li) => {
          if (Database.serverSettings.sortingIgnorePrefix) {
            return li.collapsedSeries?.nameIgnorePrefix || li.media.metadata.titleIgnorePrefix
          } else {
            return li.collapsedSeries?.name || li.media.metadata.title
          }
        }
      })
    }

    if (payload.sortBy) {
      let sortKey = payload.sortBy

      // Handle server setting sortingIgnorePrefix
      const sortByTitle = sortKey === 'media.metadata.title'
      if (sortByTitle && Database.serverSettings.sortingIgnorePrefix) {
        // BookMetadata.js has titleIgnorePrefix getter
        sortKey += 'IgnorePrefix'
      }

      // If series are collapsed and not sorting by title or sequence, 
      // sort all collapsed series to the end in alphabetical order
      const sortBySequence = filterSeries && (sortKey === 'sequence')
      if (payload.collapseseries && !(sortByTitle || sortBySequence)) {
        sortArray.push({
          asc: (li) => {
            if (li.collapsedSeries) {
              return Database.serverSettings.sortingIgnorePrefix ?
                li.collapsedSeries.nameIgnorePrefix :
                li.collapsedSeries.name
            } else {
              return ''
            }
          }
        })
      }

      // Sort series based on the sortBy attribute
      const direction = payload.sortDesc ? 'desc' : 'asc'
      sortArray.push({
        [direction]: (li) => {
          if (mediaIsBook && sortBySequence) {
            return li.media.metadata.getSeries(filterSeries).sequence
          } else if (mediaIsBook && sortByTitle && li.collapsedSeries) {
            return Database.serverSettings.sortingIgnorePrefix ?
              li.collapsedSeries.nameIgnorePrefix :
              li.collapsedSeries.name
          } else {
            // Supports dot notation strings i.e. "media.metadata.title"
            return sortKey.split('.').reduce((a, b) => a[b], li)
          }
        }
      })

      // Secondary sort when sorting by book author use series sort title
      if (mediaIsBook && payload.sortBy.includes('author')) {
        sortArray.push({
          asc: (li) => {
            if (li.media.metadata.series && li.media.metadata.series.length) {
              return li.media.metadata.getSeriesSortTitle(li.media.metadata.series[0])
            }
            return null
          }
        })
      }
    }

    if (sortArray.length) {
      libraryItems = naturalSort(libraryItems).by(sortArray)
    }

    // Step 3.5: Limit items
    if (payload.limit) {
      const startIndex = payload.page * payload.limit
      libraryItems = libraryItems.slice(startIndex, startIndex + payload.limit)
    }

    // Step 4 - Transform the items to pass to the client side
    payload.results = await Promise.all(libraryItems.map(async li => {
      const json = payload.minified ? li.toJSONMinified() : li.toJSON()

      if (li.collapsedSeries) {
        json.collapsedSeries = {
          id: li.collapsedSeries.id,
          name: li.collapsedSeries.name,
          nameIgnorePrefix: li.collapsedSeries.nameIgnorePrefix,
          libraryItemIds: li.collapsedSeries.books.map(b => b.id),
          numBooks: li.collapsedSeries.books.length
        }

        // If collapsing by series and filtering by a series, generate the list of sequences the collapsed
        // series represents in the filtered series
        if (filterSeries) {
          json.collapsedSeries.seriesSequenceList =
            naturalSort(li.collapsedSeries.books.filter(b => b.filterSeriesSequence).map(b => b.filterSeriesSequence)).asc()
              .reduce((ranges, currentSequence) => {
                let lastRange = ranges.at(-1)
                let isNumber = /^(\d+|\d+\.\d*|\d*\.\d+)$/.test(currentSequence)
                if (isNumber) currentSequence = parseFloat(currentSequence)

                if (lastRange && isNumber && lastRange.isNumber && ((lastRange.end + 1) == currentSequence)) {
                  lastRange.end = currentSequence
                }
                else {
                  ranges.push({ start: currentSequence, end: currentSequence, isNumber: isNumber })
                }

                return ranges
              }, [])
              .map(r => r.start == r.end ? r.start : `${r.start}-${r.end}`)
              .join(', ')
        }
      } else {
        // add rssFeed object if "include=rssfeed" was put in query string (only for non-collapsed series)
        if (include.includes('rssfeed')) {
          const feedData = await this.rssFeedManager.findFeedForEntityId(json.id)
          json.rssFeed = feedData ? feedData.toJSONMinified() : null
        }

        // add numEpisodesIncomplete if "include=numEpisodesIncomplete" was put in query string (only for podcasts)
        if (mediaIsPodcast && include.includes('numepisodesincomplete')) {
          json.numEpisodesIncomplete = req.user.getNumEpisodesIncompleteForPodcast(li)
        }

        if (filterSeries) {
          // If filtering by series, make sure to include the series metadata
          json.media.metadata.series = li.media.metadata.getSeries(filterSeries)
        }
      }

      return json
    }))

    res.json(payload)
  }

  async removeLibraryItemsWithIssues(req, res) {
    const libraryItemsWithIssues = req.libraryItems.filter(li => li.hasIssues)
    if (!libraryItemsWithIssues.length) {
      Logger.warn(`[LibraryController] No library items have issues`)
      return res.sendStatus(200)
    }

    Logger.info(`[LibraryController] Removing ${libraryItemsWithIssues.length} items with issues`)
    for (const libraryItem of libraryItemsWithIssues) {
      Logger.info(`[LibraryController] Removing library item "${libraryItem.media.metadata.title}"`)
      await this.handleDeleteLibraryItem(libraryItem)
    }

    res.sendStatus(200)
  }

  /**
   * api/libraries/:id/series
   * Optional query string: `?include=rssfeed` that adds `rssFeed` to series if a feed is open
   * 
   * @param {*} req 
   * @param {*} res 
   */
  async getAllSeriesForLibrary(req, res) {
    const libraryItems = req.libraryItems

    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const payload = {
      results: [],
      total: 0,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0,
      sortBy: req.query.sort,
      sortDesc: req.query.desc === '1',
      filterBy: req.query.filter,
      minified: req.query.minified === '1',
      include: include.join(',')
    }

    let series = libraryHelpers.getSeriesFromBooks(libraryItems, Database.series, null, payload.filterBy, req.user, payload.minified, req.library.settings.hideSingleBookSeries)

    const direction = payload.sortDesc ? 'desc' : 'asc'
    series = naturalSort(series).by([
      {
        [direction]: (se) => {
          if (payload.sortBy === 'numBooks') {
            return se.books.length
          } else if (payload.sortBy === 'totalDuration') {
            return se.totalDuration
          } else if (payload.sortBy === 'addedAt') {
            return se.addedAt
          } else if (payload.sortBy === 'lastBookUpdated') {
            return Math.max(...(se.books).map(x => x.updatedAt), 0)
          } else if (payload.sortBy === 'lastBookAdded') {
            return Math.max(...(se.books).map(x => x.addedAt), 0)
          } else { // sort by name
            return Database.serverSettings.sortingIgnorePrefix ? se.nameIgnorePrefixSort : se.name
          }
        }
      }
    ])

    payload.total = series.length

    if (payload.limit) {
      const startIndex = payload.page * payload.limit
      series = series.slice(startIndex, startIndex + payload.limit)
    }

    // add rssFeed when "include=rssfeed" is in query string
    if (include.includes('rssfeed')) {
      series = await Promise.all(series.map(async (se) => {
        const feedData = await this.rssFeedManager.findFeedForEntityId(se.id)
        se.rssFeed = feedData?.toJSONMinified() || null
        return se
      }))
    }

    payload.results = series
    res.json(payload)
  }

  /**
   * api/libraries/:id/series/:seriesId
   *
   * Optional includes (e.g. `?include=rssfeed,progress`)
   * rssfeed: adds `rssFeed` to series object if a feed is open
   * progress: adds `progress` to series object with { libraryItemIds:Array<llid>, libraryItemIdsFinished:Array<llid>, isFinished:boolean }
   * 
   * @param {*} req 
   * @param {*} res - Series
   */
  async getSeriesForLibrary(req, res) {
    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const series = Database.series.find(se => se.id === req.params.seriesId)
    if (!series) return res.sendStatus(404)

    const libraryItemsInSeries = req.libraryItems.filter(li => li.media.metadata.hasSeries?.(series.id))

    const seriesJson = series.toJSON()
    if (include.includes('progress')) {
      const libraryItemsFinished = libraryItemsInSeries.filter(li => !!req.user.getMediaProgress(li.id)?.isFinished)
      seriesJson.progress = {
        libraryItemIds: libraryItemsInSeries.map(li => li.id),
        libraryItemIdsFinished: libraryItemsFinished.map(li => li.id),
        isFinished: libraryItemsFinished.length >= libraryItemsInSeries.length
      }
    }

    if (include.includes('rssfeed')) {
      const feedObj = await this.rssFeedManager.findFeedForEntityId(seriesJson.id)
      seriesJson.rssFeed = feedObj?.toJSONMinified() || null
    }

    res.json(seriesJson)
  }

  // api/libraries/:id/collections
  async getCollectionsForLibrary(req, res) {
    const libraryItems = req.libraryItems

    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const payload = {
      results: [],
      total: 0,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0,
      sortBy: req.query.sort,
      sortDesc: req.query.desc === '1',
      filterBy: req.query.filter,
      minified: req.query.minified === '1',
      include: include.join(',')
    }

    const collectionsForLibrary = await Database.models.collection.getAllForLibrary(req.library.id)

    let collections = await Promise.all(collectionsForLibrary.map(async c => {
      const expanded = c.toJSONExpanded(libraryItems, payload.minified)

      // If all books restricted to user in this collection then hide this collection
      if (!expanded.books.length && c.books.length) return null

      if (include.includes('rssfeed')) {
        const feedData = await this.rssFeedManager.findFeedForEntityId(c.id)
        expanded.rssFeed = feedData?.toJSONMinified() || null
      }

      return expanded
    }))

    collections = collections.filter(c => !!c)

    payload.total = collections.length

    if (payload.limit) {
      const startIndex = payload.page * payload.limit
      collections = collections.slice(startIndex, startIndex + payload.limit)
    }

    payload.results = collections
    res.json(payload)
  }

  // api/libraries/:id/playlists
  async getUserPlaylistsForLibrary(req, res) {
    let playlistsForUser = await Database.models.playlist.getPlaylistsForUserAndLibrary(req.user.id, req.library.id)
    playlistsForUser = playlistsForUser.map(p => p.toJSONExpanded(Database.libraryItems))

    const payload = {
      results: [],
      total: playlistsForUser.length,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0
    }

    if (payload.limit) {
      const startIndex = payload.page * payload.limit
      playlistsForUser = playlistsForUser.slice(startIndex, startIndex + payload.limit)
    }

    payload.results = playlistsForUser
    res.json(payload)
  }

  // api/libraries/:id/albums
  async getAlbumsForLibrary(req, res) {
    if (!req.library.isMusic) {
      return res.status(400).send('Invalid library media type')
    }

    let libraryItems = Database.libraryItems.filter(li => li.libraryId === req.library.id)
    let albums = libraryHelpers.groupMusicLibraryItemsIntoAlbums(libraryItems)
    albums = naturalSort(albums).asc(a => a.title) // Alphabetical by album title

    const payload = {
      results: [],
      total: albums.length,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0
    }

    if (payload.limit) {
      const startIndex = payload.page * payload.limit
      albums = albums.slice(startIndex, startIndex + payload.limit)
    }

    payload.results = albums
    res.json(payload)
  }

  async getLibraryFilterData(req, res) {
    res.json(libraryHelpers.getDistinctFilterDataNew(req.libraryItems))
  }

  /**
   * GET: /api/libraries/:id/personalized2
   * TODO: new endpoint
   * @param {*} req 
   * @param {*} res 
   */
  async getUserPersonalizedShelves(req, res) {
    const limitPerShelf = req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) || 10 : 10
    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)
    const shelves = await Database.models.libraryItem.getPersonalizedShelves(req.library, req.user.id, include, limitPerShelf)
    res.json(shelves)
  }

  /**
   * GET: /api/libraries/:id/personalized
   * @param {*} req 
   * @param {*} res 
   */
  async getLibraryUserPersonalizedOptimal(req, res) {
    const limitPerShelf = req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) || 10 : 10
    const include = (req.query.include || '').split(',').map(v => v.trim().toLowerCase()).filter(v => !!v)

    const categories = await libraryHelpers.buildPersonalizedShelves(this, req.user, req.libraryItems, req.library, limitPerShelf, include)
    res.json(categories)
  }

  /**
   * POST: /api/libraries/order
   * Change the display order of libraries
   * @param {*} req 
   * @param {*} res 
   */
  async reorder(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error('[LibraryController] ReorderLibraries invalid user', req.user)
      return res.sendStatus(403)
    }
    const libraries = await Database.models.library.getAllOldLibraries()

    const orderdata = req.body
    let hasUpdates = false
    for (let i = 0; i < orderdata.length; i++) {
      const library = libraries.find(lib => lib.id === orderdata[i].id)
      if (!library) {
        Logger.error(`[LibraryController] Invalid library not found in reorder ${orderdata[i].id}`)
        return res.sendStatus(500)
      }
      if (library.update({ displayOrder: orderdata[i].newOrder })) {
        hasUpdates = true
        await Database.updateLibrary(library)
      }
    }

    if (hasUpdates) {
      libraries.sort((a, b) => a.displayOrder - b.displayOrder)
      Logger.debug(`[LibraryController] Updated library display orders`)
    } else {
      Logger.debug(`[LibraryController] Library orders were up to date`)
    }

    res.json({
      libraries: libraries.map(lib => lib.toJSON())
    })
  }

  // GET: Global library search
  search(req, res) {
    if (!req.query.q) {
      return res.status(400).send('No query string')
    }
    const libraryItems = req.libraryItems
    const maxResults = req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 12

    const itemMatches = []
    const authorMatches = {}
    const narratorMatches = {}
    const seriesMatches = {}
    const tagMatches = {}

    libraryItems.forEach((li) => {
      const queryResult = li.searchQuery(req.query.q)
      if (queryResult.matchKey) {
        itemMatches.push({
          libraryItem: li.toJSONExpanded(),
          matchKey: queryResult.matchKey,
          matchText: queryResult.matchText
        })
      }
      if (queryResult.series?.length) {
        queryResult.series.forEach((se) => {
          if (!seriesMatches[se.id]) {
            const _series = Database.series.find(_se => _se.id === se.id)
            if (_series) seriesMatches[se.id] = { series: _series.toJSON(), books: [li.toJSON()] }
          } else {
            seriesMatches[se.id].books.push(li.toJSON())
          }
        })
      }
      if (queryResult.authors?.length) {
        queryResult.authors.forEach((au) => {
          if (!authorMatches[au.id]) {
            const _author = Database.authors.find(_au => _au.id === au.id)
            if (_author) {
              authorMatches[au.id] = _author.toJSON()
              authorMatches[au.id].numBooks = 1
            }
          } else {
            authorMatches[au.id].numBooks++
          }
        })
      }
      if (queryResult.tags?.length) {
        queryResult.tags.forEach((tag) => {
          if (!tagMatches[tag]) {
            tagMatches[tag] = { name: tag, books: [li.toJSON()] }
          } else {
            tagMatches[tag].books.push(li.toJSON())
          }
        })
      }
      if (queryResult.narrators?.length) {
        queryResult.narrators.forEach((narrator) => {
          if (!narratorMatches[narrator]) {
            narratorMatches[narrator] = { name: narrator, books: [li.toJSON()] }
          } else {
            narratorMatches[narrator].books.push(li.toJSON())
          }
        })
      }
    })
    const itemKey = req.library.mediaType
    const results = {
      [itemKey]: itemMatches.slice(0, maxResults),
      tags: Object.values(tagMatches).slice(0, maxResults),
      authors: Object.values(authorMatches).slice(0, maxResults),
      series: Object.values(seriesMatches).slice(0, maxResults),
      narrators: Object.values(narratorMatches).slice(0, maxResults)
    }
    res.json(results)
  }

  async stats(req, res) {
    var libraryItems = req.libraryItems
    var authorsWithCount = libraryHelpers.getAuthorsWithCount(libraryItems)
    var genresWithCount = libraryHelpers.getGenresWithCount(libraryItems)
    var durationStats = libraryHelpers.getItemDurationStats(libraryItems)
    var sizeStats = libraryHelpers.getItemSizeStats(libraryItems)
    var stats = {
      totalItems: libraryItems.length,
      totalAuthors: Object.keys(authorsWithCount).length,
      totalGenres: Object.keys(genresWithCount).length,
      totalDuration: durationStats.totalDuration,
      longestItems: durationStats.longestItems,
      numAudioTracks: durationStats.numAudioTracks,
      totalSize: libraryHelpers.getLibraryItemsTotalSize(libraryItems),
      largestItems: sizeStats.largestItems,
      authorsWithCount,
      genresWithCount
    }
    res.json(stats)
  }

  async getAuthors(req, res) {
    const authors = {}
    req.libraryItems.forEach((li) => {
      if (li.media.metadata.authors && li.media.metadata.authors.length) {
        li.media.metadata.authors.forEach((au) => {
          if (!authors[au.id]) {
            const _author = Database.authors.find(_au => _au.id === au.id)
            if (_author) {
              authors[au.id] = _author.toJSON()
              authors[au.id].numBooks = 1
            }
          } else {
            authors[au.id].numBooks++
          }
        })
      }
    })

    res.json({
      authors: naturalSort(Object.values(authors)).asc(au => au.name)
    })
  }

  async getNarrators(req, res) {
    const narrators = {}
    req.libraryItems.forEach((li) => {
      if (li.media.metadata.narrators?.length) {
        li.media.metadata.narrators.forEach((n) => {
          if (typeof n !== 'string') {
            Logger.error(`[LibraryController] getNarrators: Invalid narrator "${n}" on book "${li.media.metadata.title}"`)
          } else if (!narrators[n]) {
            narrators[n] = {
              id: encodeURIComponent(Buffer.from(n).toString('base64')),
              name: n,
              numBooks: 1
            }
          } else {
            narrators[n].numBooks++
          }
        })
      }
    })

    res.json({
      narrators: naturalSort(Object.values(narrators)).asc(n => n.name)
    })
  }

  async updateNarrator(req, res) {
    if (!req.user.canUpdate) {
      Logger.error(`[LibraryController] Unauthorized user "${req.user.username}" attempted to update narrator`)
      return res.sendStatus(403)
    }

    const narratorName = libraryHelpers.decode(req.params.narratorId)
    const updatedName = req.body.name
    if (!updatedName) {
      return res.status(400).send('Invalid request payload. Name not specified.')
    }

    const itemsUpdated = []
    for (const libraryItem of req.libraryItems) {
      if (libraryItem.media.metadata.updateNarrator(narratorName, updatedName)) {
        itemsUpdated.push(libraryItem)
      }
    }

    if (itemsUpdated.length) {
      await Database.updateBulkBooks(itemsUpdated.map(i => i.media))
      SocketAuthority.emitter('items_updated', itemsUpdated.map(li => li.toJSONExpanded()))
    }

    res.json({
      updated: itemsUpdated.length
    })
  }

  async removeNarrator(req, res) {
    if (!req.user.canUpdate) {
      Logger.error(`[LibraryController] Unauthorized user "${req.user.username}" attempted to remove narrator`)
      return res.sendStatus(403)
    }

    const narratorName = libraryHelpers.decode(req.params.narratorId)

    const itemsUpdated = []
    for (const libraryItem of req.libraryItems) {
      if (libraryItem.media.metadata.removeNarrator(narratorName)) {
        itemsUpdated.push(libraryItem)
      }
    }

    if (itemsUpdated.length) {
      await Database.updateBulkBooks(itemsUpdated.map(i => i.media))
      SocketAuthority.emitter('items_updated', itemsUpdated.map(li => li.toJSONExpanded()))
    }

    res.json({
      updated: itemsUpdated.length
    })
  }

  async matchAll(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryController] Non-root user attempted to match library items`, req.user)
      return res.sendStatus(403)
    }
    this.scanner.matchLibraryItems(req.library)
    res.sendStatus(200)
  }

  // POST: api/libraries/:id/scan
  async scan(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[LibraryController] Non-root user attempted to scan library`, req.user)
      return res.sendStatus(403)
    }
    const options = {
      forceRescan: req.query.force == 1
    }
    res.sendStatus(200)
    await this.scanner.scan(req.library, options)
    Logger.info('[LibraryController] Scan complete')
  }

  // GET: api/libraries/:id/recent-episode
  async getRecentEpisodes(req, res) {
    if (!req.library.isPodcast) {
      return res.sendStatus(404)
    }

    const payload = {
      episodes: [],
      total: 0,
      limit: req.query.limit && !isNaN(req.query.limit) ? Number(req.query.limit) : 0,
      page: req.query.page && !isNaN(req.query.page) ? Number(req.query.page) : 0,
    }

    var allUnfinishedEpisodes = []
    for (const libraryItem of req.libraryItems) {
      const unfinishedEpisodes = libraryItem.media.episodes.filter(ep => {
        const userProgress = req.user.getMediaProgress(libraryItem.id, ep.id)
        return !userProgress || !userProgress.isFinished
      }).map(_ep => {
        const ep = _ep.toJSONExpanded()
        ep.podcast = libraryItem.media.toJSONMinified()
        ep.libraryItemId = libraryItem.id
        ep.libraryId = libraryItem.libraryId
        return ep
      })
      allUnfinishedEpisodes.push(...unfinishedEpisodes)
    }

    payload.total = allUnfinishedEpisodes.length

    allUnfinishedEpisodes = sort(allUnfinishedEpisodes).desc(ep => ep.publishedAt)

    if (payload.limit) {
      var startIndex = payload.page * payload.limit
      allUnfinishedEpisodes = allUnfinishedEpisodes.slice(startIndex, startIndex + payload.limit)
    }
    payload.episodes = allUnfinishedEpisodes
    res.json(payload)
  }

  getOPMLFile(req, res) {
    const opmlText = this.podcastManager.generateOPMLFileText(req.libraryItems)
    res.type('application/xml')
    res.send(opmlText)
  }

  async middleware(req, res, next) {
    if (!req.user.checkCanAccessLibrary(req.params.id)) {
      Logger.warn(`[LibraryController] Library ${req.params.id} not accessible to user ${req.user.username}`)
      return res.sendStatus(403)
    }

    const library = await Database.models.library.getOldById(req.params.id)
    if (!library) {
      return res.status(404).send('Library not found')
    }
    req.library = library
    req.libraryItems = Database.libraryItems.filter(li => {
      return li.libraryId === library.id && req.user.checkCanAccessLibraryItem(li)
    })
    next()
  }
}
module.exports = new LibraryController()
