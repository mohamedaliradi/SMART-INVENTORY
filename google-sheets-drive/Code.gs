/**
 * SMART INVENTORY - Google data provisioning starter.
 * Creates the central spreadsheet and Drive folder owned by the executing Google account.
 *
 * IMPORTANT: This is a provisioning scaffold, NOT a production API.
 * Do not deploy publicly until authentication, authorization, validation,
 * rate limiting, audit logging and security tests are implemented.
 */

const APP_CONFIG = Object.freeze({
  SPREADSHEET_NAME: 'SMART INVENTORY - Central Database',
  DRIVE_FOLDER_NAME: 'SMART INVENTORY - Reports and Backups',
  SHEETS: [
    { name: 'Users', headers: ['user_id', 'username', 'password_hash', 'password_salt', 'role', 'is_active', 'created_at', 'updated_at'] },
    { name: 'Branches', headers: ['branch_id', 'branch_name', 'is_active'] },
    { name: 'Items', headers: ['item_id', 'barcode', 'item_code', 'item_name', 'unit', 'category', 'is_active', 'updated_at'] },
    { name: 'InventorySessions', headers: ['session_id', 'branch_id', 'warehouse_id', 'session_name', 'status', 'created_by', 'created_at'] },
    { name: 'InventoryLines', headers: ['line_id', 'session_id', 'item_id', 'counted_qty', 'expiry_date', 'employee_username', 'counted_at', 'notes'] },
    { name: 'AuditLog', headers: ['event_id', 'actor', 'action', 'entity', 'entity_id', 'event_time', 'details'] },
    { name: 'Settings', headers: ['setting_key', 'setting_value', 'updated_at'] }
  ]
});

/**
 * Run manually once from the Apps Script editor while signed in to the
 * Google account that should own the data.
 */
function setupDatabase() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const props = PropertiesService.getScriptProperties();
    let spreadsheetId = props.getProperty('SMART_INVENTORY_SPREADSHEET_ID');
    let spreadsheet;

    if (spreadsheetId) {
      spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    } else {
      spreadsheet = SpreadsheetApp.create(APP_CONFIG.SPREADSHEET_NAME);
      spreadsheetId = spreadsheet.getId();
      props.setProperty('SMART_INVENTORY_SPREADSHEET_ID', spreadsheetId);
    }

    APP_CONFIG.SHEETS.forEach(def => {
      let sheet = spreadsheet.getSheetByName(def.name);
      if (!sheet) sheet = spreadsheet.insertSheet(def.name);
      if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
        sheet.setFrozenRows(1);
      }
    });

    // Remove the default blank sheet only when all required sheets exist.
    const defaultSheet = spreadsheet.getSheetByName('Sheet1');
    if (defaultSheet && spreadsheet.getSheets().length > APP_CONFIG.SHEETS.length) {
      spreadsheet.deleteSheet(defaultSheet);
    }

    let folderId = props.getProperty('SMART_INVENTORY_DRIVE_FOLDER_ID');
    let folder;
    if (folderId) {
      folder = DriveApp.getFolderById(folderId);
    } else {
      folder = DriveApp.createFolder(APP_CONFIG.DRIVE_FOLDER_NAME);
      folderId = folder.getId();
      props.setProperty('SMART_INVENTORY_DRIVE_FOLDER_ID', folderId);
    }

    const result = {
      status: 'created_or_verified',
      spreadsheetName: spreadsheet.getName(),
      spreadsheetUrl: spreadsheet.getUrl(),
      driveFolderName: folder.getName(),
      driveFolderUrl: folder.getUrl(),
      message: 'تم إنشاء/التحقق من موارد SMART INVENTORY بنجاح.'
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Intentionally no public doGet/doPost endpoint yet.
 * The authenticated API will be added only after the database owner confirms
 * successful provisioning. This prevents exposing an unauthenticated endpoint.
 */
