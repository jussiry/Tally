/*
Route types: what parseRoute in app.js turns a URL hash into, and what the
page binders and page transitions switch on. A subpage's type is also the
name of its HTML file under ui-modules/subpage/. URL hashes themselves stay
literal: they are addresses, not this vocabulary.
@category ui
*/

export const ROUTE_WELCOME = "welcome";
// A main tab (tally, friends, logs, settings); the tab is in `route.page`.
export const ROUTE_PAGE = "page";
export const ROUTE_FRIEND = "friend";
export const ROUTE_ADD_FRIEND = "add-friend";
export const ROUTE_RECORD = "record";
export const ROUTE_REQUEST = "request";
export const ROUTE_TRUST = "trust";
export const ROUTE_TRANSFER = "transfer";
export const ROUTE_NOTIFICATIONS = "notifications";
