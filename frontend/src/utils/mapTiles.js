// Tile layers for every Leaflet map in the portal.
//
// OpenStreetMap's tile servers are run by volunteers and refuse requests that
// break their usage policy (https://operations.osmfoundation.org/policies/tiles/).
// They were refusing all of ours: the server's Referrer-Policy stripped the
// Referer header, and a tile request without one gets an "Access blocked" image
// instead of the map. The page header now sends the origin, and each layer asks
// for the same policy itself, so a future header change can't silently break
// the maps again. The policy also requires visible attribution and the plain
// tile.openstreetmap.org host rather than the old a/b/c subdomains.
const REFERRER_POLICY = 'strict-origin-when-cross-origin';

export const MAP_TILES = {
  street: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    referrerPolicy: REFERRER_POLICY,
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxZoom: 19,
    referrerPolicy: REFERRER_POLICY,
  },
};
