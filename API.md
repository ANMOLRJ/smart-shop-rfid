# API Contract

Base URL in production:

`https://YOUR-PROJECT.vercel.app/api`

All responses are JSON. Browser requests should include `Authorization: Bearer <Firebase ID token>`. Hardware requests can use `X-Device-Key` when `DEVICE_API_KEY` is configured.

## Health

`GET /api?action=health`

## Browser actions

### loginFirebase

POST JSON:

```json
{"action":"loginFirebase","firebaseUid":"...","phone":"+91...","email":"...","name":"Owner","shopName":"Shop"}
```

### dashboard

`GET /api?action=dashboard&shopId=SHOP001`

### saveProduct

POST fields:

`shopId, shopName, userId, barcode, name, brand, category, mrp, sellingPrice, manufacturingDate, expiryDate, quantity, barcodeSource, detailsSource, ocrText`

### deleteProduct

POST: `shopId, barcode`

### recordSale

POST: `shopId, userId, shopName, barcode, quantity`

### exitEvents

`GET /api?action=exitEvents&shopId=SHOP001`

### removeExitEvent

POST: `shopId, eventId`

### payExitEvents

POST: `shopId, shopName, userId, firebaseUid, eventIds`

### updateExitCount

POST: `shopId, exitCount`

## Hardware actions

### rfidPending

`GET /api?action=rfidPending&shopId=SHOP001&shopName=TESLA`

The response includes `pending`, `assignmentId`, `barcode`, `productName`, `quantity`, `assignedCount` and `remainingCount`.

### assignRFID

POST JSON:

```json
{"action":"assignRFID","assignmentId":"ASN...","shopId":"SHOP001","shopName":"TESLA","barcode":"...","rfidUid":"21837C66"}
```

### exitDetect

POST form or JSON:

```json
{"action":"exitDetect","shopId":"SHOP001","shopName":"TESLA","exitNo":1,"rfidUid":"21837C66"}
```

A successful exit creates a `WAITING_PAYMENT` event, marks the RFID `EXITED`, and decreases product quantity by one.
