# Smart Shop RFID — Next.js + Express + MongoDB Atlas

This project replaces the Google Apps Script + Google Sheets backend with:

- **Frontend:** Next.js
- **Hosting:** Vercel
- **API:** Node.js + Express as a Vercel serverless function (`/api`)
- **Database:** MongoDB Atlas M0
- **Authentication:** Firebase Phone OTP + Firebase Admin token verification
- **Barcode:** browser camera + ZXing
- **OCR:** Tesseract.js in the browser
- **Hardware:** ESP8266 RC522 RFID assigner + ESP32 RC522 exit door

The API keeps the same action names used by the existing system so the RFID workflow remains familiar: `rfidPending`, `assignRFID`, `exitDetect`, `exitEvents`, `payExitEvents`, `saveProduct`, `dashboard`, `recordSale`, `deleteProduct`, `removeExitEvent`, `updateExitCount`.

## 1. MongoDB Atlas M0

Create a free M0 cluster in MongoDB Atlas.

Create a database user and allow your deployment to connect. For a quick first deployment, Atlas Network Access can allow `0.0.0.0/0`; use stronger network controls if your deployment setup supports them.

Use a URI like:

`mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?retryWrites=true&w=majority`

The application creates these collections/indexes automatically:

- `users`
- `products`
- `rfidAssignments`
- `rfidInventory`
- `sales`
- `exitEvents`

## 2. Firebase Phone OTP

The existing Firebase project configuration from the old site is already represented in `.env.example`.

In Firebase Console:

1. Enable Phone Authentication.
2. Add your Vercel domain to Authorized domains.
3. Create a Firebase Admin service account.
4. Put its project ID, client email and private key into the Vercel environment variables.

Do not commit the Admin private key.

## 3. Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open the Next.js site at `http://localhost:3000`.

The Express API can also be run separately for a pure local API test:

```bash
npm run api
```

That starts the same Express application at `http://localhost:3000` when no other process is using the port.

## 4. Vercel deployment

Import this repository into Vercel.

Set these Environment Variables:

```text
MONGODB_URI
MONGODB_DB
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
NEXT_PUBLIC_FIREBASE_API_KEY
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
NEXT_PUBLIC_FIREBASE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
NEXT_PUBLIC_FIREBASE_APP_ID
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID
DEVICE_API_KEY   (optional)
```

Deploy. Your API will be:

```text
https://YOUR-PROJECT.vercel.app/api
```

Health check:

```text
https://YOUR-PROJECT.vercel.app/api?action=health
```

Expected response contains:

```json
{"ok":true,"service":"Smart Shop RFID API"}
```

## 5. ESP8266 RFID assigner

Open `hardware/ESP8266_RFID_ASSIGNER_MONGODB_API.ino`.

Change:

```cpp
const char* API_BASE = "https://YOUR-PROJECT.vercel.app/api";
```

The existing ESP8266 wiring is preserved: RC522 SDA/SS D2, RST D1, SCK D5, MOSI D7, MISO D6.

## 6. ESP32 Exit Door #1

Open `hardware/ESP32_EXIT_DOOR_1_MONGODB_API.ino`.

Change:

```cpp
const char* API_HOST = "YOUR-PROJECT.vercel.app";
const char* API_PATH = "/api";
```

The existing wiring is preserved: SDA/SS GPIO5, RST GPIO22, SCK GPIO18, MOSI GPIO23, MISO GPIO19.

The new Express API responds directly with JSON, so the old Google Apps Script redirect handling is no longer required by the backend. The supplied sketch still tolerates redirects for compatibility.

## 7. Optional hardware API key

For production, set:

```text
DEVICE_API_KEY=your-long-random-device-key
```

Then put the same value into both sketches:

```cpp
const char* DEVICE_API_KEY = "your-long-random-device-key";
```

The ESP code sends it as `X-Device-Key`.

If you leave `DEVICE_API_KEY` empty, the API accepts the hardware requests using the existing shop ID/name workflow. This is convenient for initial testing but less secure.

## 8. Important data behavior

The MongoDB implementation preserves the existing multi-RFID logic:

- Quantity 3 means 3 physical units and 3 RFID assignments are required.
- An active RFID represents one physical unit.
- An exit scan consumes exactly one active RFID and decreases product quantity by 1.
- A used RFID cannot exit again.
- Exit detections remain `WAITING_PAYMENT` until the owner pays them.
- Removing a waiting exit event restores one unit and reactivates its RFID.
- Manual sales consume active RFID tags and decrease quantity.
- Product documents remain visible when quantity reaches zero.
- Deleting a product removes the product and pending assignments; active RFID records are marked `UNASSIGNED`.

## 9. Existing Google Sheets data

This version does not read Google Sheets at runtime. If you want to migrate existing data, export the six relevant Sheets as CSV/JSON and map them to the MongoDB collections above. A future migration script can be added without changing the web UI or RFID API contract.
