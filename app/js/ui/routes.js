/*
Route types: what parseRoute in app.js turns a URL hash into, and what the
page binders and page transitions switch on. A subpage's type is also the
name of its HTML file under ui-modules/subpage/. URL hashes themselves stay
literal: they are addresses, not this vocabulary.
@category ui
*/

export const Route = Object.freeze({
  WELCOME: "welcome",
  // A main tab (tally, friends, logs, settings); the tab is in `route.page`.
  PAGE: "page",
  FRIEND: "friend",
  ADD_FRIEND: "add-friend",
  RECORD: "record",
  REQUEST: "request",
  TRUST: "trust",
  TRANSFER: "transfer",
  NOTIFICATIONS: "notifications",
  SEND_LINK: "send-link",
});
