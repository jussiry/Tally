/*
 * tip-order.js — the ranking of unimplemented TIPs on the TODO page, most
 * important first. Written by the Design dev server (POST /api/tip-order) when
 * a box is dragged on tips-todo.html; a plain global so the page also works
 * from file://. TIPs missing here are listed after these, in pages.js order.
 */

window.TIP_ORDER = [
  "tip-7-routed-payments.html",
  "tip-2-circular-cancellation.html",
  "tip-1-user-merge.html",
  "tip-3-relay-sharing.html",
  "tip-6-remote-signers.html",
  "tip-8-bilateral-checkpoints.html",
  "tip-9-offline-intermediaries.html"
];
