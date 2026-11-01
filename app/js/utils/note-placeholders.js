/*
A small collection of example note texts shown as placeholder hints in the send
and request forms. A random entry is picked each time the form loads so the UI
feels alive and gives users a quick sense of what kinds of things Tally is for.
@category util
*/

const NOTE_PLACEHOLDERS = [
  "for helping in renovation",
  "for selling a pink bike",
  "for paying the lunch",
  "for babysitting",
  "for covering the groceries",
  "for the concert tickets",
  "for fixing the car",
  "for the weekend trip",
  "for dog sitting",
  "for lending the van",
  "for the moving help",
  "for seeling the teak table",
  "for the taxi ride",
  "for covering the bar tab",
  "for the ski trip",
  "for picking up from the airport",
  "for the shared streaming subscription",
  "for the birthday dinner",
  "for fixing the fence",
  "for the ferry tickets",
  "for covering the rent",
  "for the camping gear",
];

// Prefixed "e.g." so it reads as an example, not as text already entered.
export const randomNotePlaceholder = () =>
  `e.g. ${NOTE_PLACEHOLDERS[Math.floor(Math.random() * NOTE_PLACEHOLDERS.length)]}`;
