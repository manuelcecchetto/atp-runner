# Document Metadata Flow Inventory

Goal: map every place that creates, persists, or consumes `Document.metadata` so clause-segmentation work can extend the structure safely.

## Canonical shape & persistence

- `review-api/models/Document.js` defines the authoritative metadata shape on the server (`title`, `summary`, `contractValue`, `parties`, `contractType`). The constructor normalizes every document instance and `cleanUndefined` drops missing fields before Firestore writes.
- Metadata lives inside the `reviewDocuments` collection; `DocumentContent` versions and datastructures for the same document are stored under `reviewDocumentsContent` with the JSON datastructure in Cloud Storage at `datastructures/<documentId>/<timestamp>.json` (`review-api/models/DocumentContent.js`).
- `Document.updateMetadata`, `updateStatus`, and `updateCurrentContentId` encapsulate Firestore mutations, so any new metadata fields should be surfaced there first.
- The background worker mirrors these conventions: `review-worker/src/services/databaseService.js` reads/writes the same collections, exposes `updateDocumentMetadata`, and will merge new keys into the stored `metadata` object.

## Metadata producers (ingestion & prompts)

| Flow | Location | Notes |
| --- | --- | --- |
| Async DOCX upload (`POST /documents/upload/docx`) | `review-api/controllers/documents/uploadDocxAsync.js` | Saves DOCX to Firebase Storage, calls DOCX microservice for structure, creates an OpenAI assistant over `dataStructureToIdText`, fetches the default `type === "metadata"` Firestore prompt (`reviewPrompts` collection), runs `AiService.runThreadPrompt`, parses the JSON, and persists it on the new `Document` while queuing the Bull job for deeper analysis. |
| Legacy synchronous DOCX upload (`POST /documents/upload`) | `review-api/controllers/documents/uploadDocx.js` | Same metadata prompt flow but blocks until everything (including schema extraction) finishes; immediately returns `document.toJSON()` with metadata. |
| Word add-in upload (`POST /documents/upload/word`) | `review-api/controllers/documents/uploadFromWord.js` | Accepts DOCX base64 from Word, recreates the DOCX microservice path, runs the same metadata prompt, saves metadata + `processingStatus`, and enqueues a background job while notifying the browser via WebSocket. |
| Word sync (metadata fallback) | `review-api/controllers/documents/syncFromWord.js` | Does **not** re-run metadata but relies on `Document.updateMetadata` if future syncs include metadata patches. |
| PDF upload (`POST /documents/upload/pdf`) | `review-api/controllers/documents/uploadPdf.js` | Extracts raw text with `pdf-parse`, feeds it to the default metadata prompt through `AiService`, stores the resulting metadata, and marks the document `ready`. |
| Local extraction for Word add-in (`POST /documents/metadata/extract-local`) | `review-api/controllers/documents/extractMetadataLocal.js` | Converts `{ paragraphId: text }` into a prompt payload, retrieves the same Firestore prompt, and uses `AiServiceModern.runPrompt` with `isJsonResponse: true`. Returns metadata but does **not** persist it; consumers cache it locally. |

All producers depend on the `reviewPrompts` collection row where `type === "metadata"` and `default === true`. The worker also exposes `getMetadataPrompt()` for parity.

## Persistence & backend consumers

- **Document serialization**: `review-api/controllers/documents/getById.js` and `getByUserId.js` call `Document.toJSON()`, so any metadata fields present are automatically sent to clients and to downstream exports.
- **Background jobs**: `review-worker/src/jobs/processors/docxProcessor.js` fetches `reviewDocuments` first (“Document metadata not found” is logged when missing) and updates `processingStatus`. It does not mutate metadata today but will rely on `databaseService.updateDocumentMetadata()` if clause segmentation writes data asynchronously.
- **Exports**: `review-worker/src/jobs/processors/reviewExportProcessor.js` injects `documentRecord.metadata` into the export payload and HTML (title, contractType, contractValue, parties appear near lines 670–673). Missing metadata means blank cells in PDFs.
- **Comparison flows**: `review-worker/src/jobs/processors/compareProcessor.js` retrieves metadata solely to locate the storage blob before parsing.
- **Database utilities**: `review-worker/src/services/databaseService.js` exposes `getReviewDocument`, `updateDocumentProcessingStatus`, `updateDocumentMetadata`, and `getMetadataPrompt`, ensuring future workers use the same metadata shape.

## API surfaces

- `GET /documents/:id` (`review-api/controllers/documents/getById.js`) – returns a single document with metadata and optionally the latest content/datastructure, used by the review UI.
- `GET /documents/user/:userId` (`review-api/controllers/documents/getByUserId.js`) – powers the “Recent Documents” view and exposes metadata for each entry.
- `POST /documents/metadata/extract-local` – Word add-in uses this without persisting anything.
- `POST /documents/:id/apply-changes`, `/sync/word`, etc., indirectly rely on metadata staying consistent because they invoke `Document.getById` and will reserialize metadata in their responses.

## Review web consumers (React app under `review/`)

- **Type definition**: `review/src/types.ts` keeps `metadata` required and typed; any additional fields (e.g., `clauses`) must be added here for TypeScript safety.
- **DocumentContextProvider** (`review/src/providers/DocumentContextProvider.tsx`) normalizes API responses into the `Document` type so every consumer receives `metadata.title`, `metadata.parties`, etc., even if they’re `null`.
- **ReviewPanel & MetadataDisplay** (`review/src/components/Panels/ReviewPanelComponent.tsx` and `components/Panels/components/MetadataDisplay.tsx`) render title, parties list (comma-separated), contract value, and contract type. These components assume strings and an array of strings for parties.
- **Recent documents view** (`review/src/hooks/useRecentDocuments.ts` + `components/Common/Document/Reviews.tsx`) reads `metadata.contractType`, `metadata.parties`, and `metadata.contractValue` for list columns, so empty/missing data renders as blanks.
- **General review forms** (`review/src/components/Panels/GeneralReviewsPanel/GeneralReviewsPanel.Form.Parties.tsx` and `pages/___New/Document/*/*.Form.tsx`) rely on `metadata.parties` to pre-populate party selectors.
- **Other contexts**: `review/src/hooks/RecentDocuments/Context.tsx` and `ReviewPanelComponent` pass metadata through React context so panel tabs, banners, and forthcoming clause UIs can read the same shape.

## Word add-in consumers (`casus-word/`)

- **Type + storage**: `casus-word/src/taskpane/types.ts` defines `DocumentMetadata`, and `hooks/useMetadataStorage.ts` caches the JSON blob in `Office.context.document.settings` so metadata survives session reloads.
- **DocumentInterface** (`casus-word/src/taskpane/wrappers/DocumentInterface/DocumentInterface.tsx`) owns the live metadata state; it imports `metadataAPI.extractLocal`, deduplicates requests via `metadataCacheRef`, marks metadata as “dirty” when the document changes, and updates Word settings once new metadata arrives. Fields currently used: `title`, `contractType`, `contractValue`, `parties`.
- **UI components**: `components/common/MetadataDisplay.tsx` renders the metadata fields with graceful fallbacks, while the Landing panel (`components/Panels/Landing/Landing.tsx`) shows extraction progress/errors. Proofread and General Review panels (`components/Panels/Proofread/Proofread.New.tsx`, `components/Panels/GeneralReview/GeneralReview.New.tsx`) pull `metadata.parties` to filter risks.
- **Smart metadata hook**: `hooks/useSmartMetadata.ts` orchestrates when to call the API, when to rely on cached metadata, and when to skip extraction (e.g., empty documents), preventing duplicate HTTP calls.

## Flow from upload to UI

1. **Client upload** – Browser or Word add-in converts the file to base64 and calls the relevant `/documents/upload/*` endpoint.
2. **Storage & parsing** – Controller writes the original file to Firebase Storage (`docx-microservice/tmp` or `pdf-microservice/tmp`) and requests the DOCX microservice or pdf parser for structure/text.
3. **Metadata prompt** – Controller loads the default `reviewPrompts` “metadata” prompt, runs it through `AiService`/`AiServiceModern`, and parses the JSON into `{ title, summary, contractValue, contractType, parties }`.
4. **Document creation** – `new Document({... metadata })` persists metadata to the `reviewDocuments` collection; `DocumentContent` stores the datastructure blob for later worker steps.
5. **Background processing** – Bull jobs (`docxProcessor`) move the document through “processing ➜ completed,” optionally saving structural schemas. If future clause segmentation updates metadata, they should do so through `databaseService.updateDocumentMetadata`.
6. **API consumption** – `GET /documents/:id`/`GET /documents/user/:userId` expose metadata to the React app. Word add-in either consumes those endpoints (sync flows) or calls `/documents/metadata/extract-local` for local previews before upload.
7. **UI rendering** – Review web surfaces title/parties/value/type in `MetadataDisplay`, document tables, and party selectors; Word add-in displays the same fields and caches them for offline awareness. Review exports embed metadata in generated PDFs via `reviewExportProcessor`.

This inventory enumerates every producer and consumer so new clause segmentation data (e.g., `metadata.clauses`) can be threaded through the same choke points with minimal surprise.
