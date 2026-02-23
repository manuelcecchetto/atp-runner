### Contract Clause Segmentation – Requirements (Draft)

#### 1. Goal & Context

- Replace or extend the current document-level metadata extraction with a richer **clause-level segmentation** of contracts.
- Input for the AI comes from the existing document data structures:
  - DOCX flows: `DataStructureFactory.createFromDocxService(...)` output + `utils.dataStructureToIdText(...)` (see `uploadDocxAsync`, `uploadDocx`, `uploadFromWord`).
  - PDF flow: current plain-text extraction in `uploadPdf`.
- The new AI prompt returns JSON with:
  - Top-level `clauses` array.
  - Each clause: `{ id, segment_ids, label, summary }`, where `segment_ids` are IDs from the document’s segments (paragraphs / table cells).

This document clarifies **scope, storage shape, API behavior, UI expectations, and compatibility** so implementation tasks can proceed without further product ambiguity. Values below are proposed defaults that can be refined with stakeholders, but they are concrete enough to implement.

---

#### 2. High‑Level Decisions (Summary)

- **D1 – Extend, don’t replace, metadata:**  
  Existing metadata fields (`title`, `summary`, `contractValue`, `contractType`, `parties`) **remain** and are still populated by the current metadata prompt. Clause segmentation is an **additional structure** alongside them.

- **D2 – Canonical storage location:**  
  Clause segmentation is stored as `Document.metadata.clauses` in Firestore and exposed unchanged via the document JSON API (`Document.toJSON()`).

- **D3 – Canonical clause JSON shape:**
  ```json
  {
    "clauses": [
      {
        "id": "clause_1",
        "segment_ids": ["10001", "10002"],
        "label": "Confidentiality",
        "summary": "High-level natural language summary of the clause."
      }
    ]
  }
  ```

- **D4 – Initial flow coverage:**  
  - **In scope (MVP):** `uploadDocxAsync`, `uploadFromWord`, `uploadDocx` (legacy), and `syncFromWord` (Word sync) should eventually populate or refresh `metadata.clauses` for DOCX contracts.  
  - **Deferred:** `uploadPdf` and `extractMetadataLocal` do **not** need to populate `metadata.clauses` in the first iteration (see §4).

- **D5 – UI exposure:**  
  The web review app shows:
  - Existing metadata as today.
  - A new **“Clauses” view** that lists clauses (`label`, short `summary`) and allows navigation to related paragraphs by `segment_ids`.
  Word add‑in support is **nice‑to‑have** and can be added once the web UX is validated.

- **D6 – Non‑functional defaults:**  
  - Maximum contract size for segmentation: ~**1,000 segments** (paragraph/table segments) per run; above that, segmentation is skipped with a recorded reason.
  - Target end‑to‑end latency for segmentation on typical contracts (≤ 100 pages): **≤ 60 seconds** from ingestion to clauses availability.
  - Segmentation is **re‑runnable** on demand (manual “Re-run segmentation” action) and **optionally** re‑run on major content updates (e.g., Word sync) if cost permits.

---

#### 3. Scope & Affected Document Types

- **Contract types in scope**
  - All contracts currently supported by the review app that go through DOCX-based ingestion flows (`uploadDocxAsync`, `uploadFromWord`, `uploadDocx`, `syncFromWord`).
  - Segmentation is **designed for contracts**, but technically can run on any DOCX document that has a `datastructure` with segment IDs.

- **PDF contracts**
  - Today `uploadPdf` uses `pdf-parse` to extract raw text and stores it in `DocumentContent.content` without a DOCX-like data structure.
  - For MVP, **PDF clause segmentation is out of scope**. PDF uploads will continue to have only document-level metadata.
  - Future extension: introduce a PDF segmentation pipeline that produces pseudo‑segments with IDs so the same clause model can be reused.

- **Word add‑in “local only” flows**
  - `extractMetadataLocal` returns metadata for a transient, local document structure and does not persist a `Document`.
  - For MVP, it **does not need to return clauses**; it remains a lightweight metadata-only endpoint.

---

#### 4. Ingestion Flows & Responsibilities

For each ingestion/sync flow, this section defines whether and how it must populate `metadata.clauses`.

1. **`uploadDocxAsync` (primary DOCX upload – web app)**
   - After metadata extraction (current `reviewPrompts` type `"metadata"`), a **second prompt** runs the clause segmentation using the same `dataStructureToIdText` mapping.
   - The result JSON is normalized to:
     ```json
     {
       "clauses": [ { "id": "...", "segment_ids": [], "label": "...", "summary": "..." } ]
     }
     ```
   - `Document.metadata.clauses` is set to the `clauses` array (empty array on failure).

2. **`uploadFromWord` (Word add‑in DOCX export + sync)**
   - Uses the same DOCX parsing pipeline as `uploadDocxAsync`.
   - Behavior mirrors `uploadDocxAsync`:
     - Populate `Document.metadata.clauses` during initial upload.
     - Queue optional background jobs to refine or re-run segmentation without blocking the initial response.

3. **`uploadDocx` (legacy synchronous upload)**
   - For backwards compatibility, segmentation should **also** be triggered here, reusing exactly the same prompting and storage behavior as `uploadDocxAsync`.
   - If this route is considered deprecated, it can share a common helper with `uploadDocxAsync` so behavior stays aligned with minimal maintenance.

4. **`syncFromWord` (Word add‑in document sync)**
   - After major content updates (e.g., large diff in segments / text), segmentation *may* be stale.
   - Decision:
     - **MVP:** `syncFromWord` does **not** automatically re‑run segmentation; instead, it marks existing clauses as potentially stale (e.g., via a flag in metadata) and exposes a UI control to re‑run segmentation.
     - **Future:** optional automatic re‑run when change volume passes a threshold.

5. **`uploadPdf`**
   - For MVP, **no clause segmentation** is attempted:
     - `Document.metadata.clauses` is omitted or set to `[]`.
     - Review UI should gracefully handle absence of clauses.

6. **`extractMetadataLocal`**
   - Remains a metadata-only endpoint returning `{ metadata }` without persisting documents.
   - No clause segmentation requirement for MVP to keep the endpoint fast and cheap.

---

#### 5. Data Model & Storage Shape

1. **Document model (backend – `review-api/models/Document.js`)**
   - Extend the `metadata` object with an optional `clauses` array:
     ```js
     this.metadata = {
       title: data.metadata?.title || null,
       summary: data.metadata?.summary || null,
       contractValue: data.metadata?.contractValue || null,
       parties: data.metadata?.parties || [],
       contractType: data.metadata?.contractType || null,
       clauses: data.metadata?.clauses || undefined // optional, cleaned by cleanUndefined
     };
     ```
   - `toFirestore()` continues to store `metadata` as-is; `cleanUndefined` ensures missing `clauses` are not written.
   - `toJSON()` exposes the `metadata.clauses` field directly.

2. **Clause JSON contract**
   - Stored and returned as:
     ```ts
     type Clause = {
       id: string;              // Unique within a document; string to allow "clause_1" etc.
       segment_ids: string[];   // References DocumentDataStructure segment IDs.
       label: string;           // Short human-readable name, e.g. "Confidentiality".
       summary: string;         // 1–3 sentence summary, plain text.
     };
     ```
   - The **ordering of the `clauses` array is the canonical clause order** in the contract; `id` does not need to encode order.

3. **Relation to `DocumentContent.datastructure`**
   - `segment_ids` must match the IDs used in `DocumentDataStructure.segments` (and, where relevant, table cell / header / footer segments).
   - If a segment referenced in `segment_ids` is later deleted or heavily edited, the clause may become stale or partially invalid:
     - MVP behavior: leave `segment_ids` as-is; re-running segmentation will recompute a fresh mapping.

4. **Frontend typing (`review/src/types.ts`)**
   - Extend `Document["metadata"]` with an optional `clauses?: Clause[]` type mirroring the backend contract.
   - UI components consume this type but must handle `undefined`/empty arrays gracefully.

---

#### 6. API Exposure

- **Existing document API**
  - The primary document JSON endpoint (`GET /document/:id` via `Document.toJSON()`) includes:
    ```json
    {
      "id": "...",
      "filename": "...",
      "metadata": {
        "title": "...",
        "summary": "...",
        "contractValue": "...",
        "contractType": "...",
        "parties": [...],
        "clauses": [
          { "id": "clause_1", "segment_ids": ["10001"], "label": "Confidentiality", "summary": "..." }
        ]
      },
      ...
    }
    ```
  - No separate endpoint is required for MVP; consumers get clauses whenever they fetch a document.

- **Versioning / compatibility**
  - New clients can rely on `metadata.clauses` when present.
  - Old clients that ignore unknown fields are unaffected by the addition.

---

#### 7. Review UI Requirements (Web)

1. **Metadata panel (existing)**
   - `MetadataDisplay` continues to show:
     - Parties
     - Contract value
     - Contract type
     - Title
   - No breaking changes for users who do not care about clauses.

2. **New “Clauses” view**
   - Add a dedicated clauses view reachable from the main review panel (e.g., an additional button next to Grammar/General/Benchmark, or a subsection under metadata).
   - For each clause in `metadata.clauses`:
     - Show `label` as the primary text.
     - Show a truncated `summary` (e.g., first 1–2 sentences).
     - Optionally display an index ("Clause 1", "Clause 2", ...).

3. **Navigation behavior**
   - Clicking a clause:
     - Navigates the main document view to the first segment in `segment_ids`.
     - Highlights all associated segments (e.g., background tint) while the clause is selected.
   - If `segment_ids` references segments that no longer exist (stale mapping), the UI:
     - Shows a non-blocking warning (“This clause may be out of date; re-run segmentation.”).
     - Falls back to showing the summary without navigation.

4. **Empty / missing clauses**
   - If `metadata.clauses` is `undefined` or an empty array:
     - Show a neutral state (“Clauses are not yet available for this document”) and, if permissions allow, a “Run clause segmentation” action.

---

#### 8. Word Add‑in UX Expectations

- **MVP**
  - The Word add-in continues to rely on document‑level metadata only.
  - It may optionally display whether clause segmentation has been generated for the corresponding cloud document (read‑only indicator using the document API).

- **Future (post‑MVP)**
  - Add support for showing clause lists in Word, reusing `metadata.clauses`.
  - Provide a “Re-run clause segmentation” action that triggers a backend job; results flow back into the web app and Word add-in after completion.

---

#### 9. Non‑Functional Requirements & Fallbacks

1. **Maximum document size for segmentation**
   - Segmenting very large contracts is expensive and may time out.
   - For MVP:
     - Hard limit: **1,000 segments** (paragraph / table segments) per segmentation run.
     - If exceeded:
       - Do not call the clause segmentation prompt.
       - Persist a machine-readable reason in metadata (e.g., `metadata.clauses = []` and `metadata.clauses_status = "too_large"`).

2. **Latency targets**
   - For typical contracts (≤ 100 pages / ≤ 1,000 segments):
     - Target: **≤ 60 seconds** from ingestion to clauses being available.
     - Segmentation should be performed asynchronously where possible (e.g., via background jobs for Word flows) so initial upload responses remain fast.

3. **Malformed AI output**
   - If the segmentation prompt returns invalid JSON or incorrect shape:
     - Log the error with enough context (document ID, model, prompt version).
     - Store a safe fallback:
       - `metadata.clauses = []`.
       - Optional diagnostics field, e.g., `metadata.clauses_status = "parse_error"`.
     - Do **not** block document access; the document remains fully viewable.

4. **Re-runnability**
   - Users with appropriate permissions can trigger re-segmentation from the UI.
   - Re-running:
     - Overwrites `metadata.clauses` with the latest result.
     - Leaves existing document metadata fields untouched.

---

#### 10. Backward Compatibility & Migration

- Existing documents without clause data:
  - Continue to load with `metadata` unchanged.
  - `metadata.clauses` will be absent until segmentation is run.
- Newly ingested DOCX documents:
  - Populate `metadata` (title, summary, etc.) as today.
  - Additionally populate `metadata.clauses` when segmentation succeeds.
- No changes are required for existing API consumers that do not care about clauses; they can remain unchanged.

---

#### 11. Open Questions (for Stakeholder Follow‑Up)

These do not block implementation but should be clarified with the product owner:

1. **Business UX priorities**
   - Is the initial goal primarily an outline/navigation aid, or will downstream features (e.g., clause-level review, export) rely on `metadata.clauses`?
2. **PDF support timeline**
   - When should we invest in PDF segmentation, and is approximate segmentation acceptable for scans / poor OCR?
3. **Automatic vs. manual re-runs**
   - How aggressively should the system auto-refresh clauses after edits versus asking users to re-run explicitly?
4. **Clause labeling taxonomy**
   - Should labels be free-text (“Termination”) or align with a predefined taxonomy that other features depend on?

This requirements note should be treated as the current source of truth for the clause segmentation feature until revised and signed off by stakeholders.

