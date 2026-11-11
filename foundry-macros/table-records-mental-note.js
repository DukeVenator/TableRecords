/*
 * TableRecords mental-note macro
 *
 * Create a Script Macro with this one line and drag it to the hotbar. The
 * optional TableRecords Bridge module must be enabled on the GM client.
 */
if (game.tableRecords?.openMentalNote) {
  game.tableRecords.openMentalNote();
} else {
  ui.notifications.warn(
    "TableRecords: enable the TableRecords Bridge module on the GM client, then reload the world."
  );
}
