# WBS-003 · Product decisions in progress

Source: https://app.notion.com/p/40bbd7ec20cd813f8550ff9f394bbbc6
Decision date: 2026-11-01 (Asia/Seoul)
Decision maker: 이문찬
Status: In Progress; this records user decisions, not feature implementation or QA completion.

## Confirmed study target

- Academic term: 2026학년도 2학기
- Course: 논리회로
- LMS URL: https://khcanvas.khu.ac.kr/courses/95899
- Source course ID: 95899
- Evidence: explicit user selection in the project conversation.

## Confirmed document support

- A document support: PDF first, explicitly selected by the user on 2026-11-01.
- Initial sample: 18 exposed weekly course PDFs; text extraction and circuit-diagram quality remain to be tested.

## Confirmed remaining decisions

- Translation: English ↔ Korean. Easy explanation remains a separate action.
- File operations: create/edit in explicitly user-selected external folders as well as the app workspace. Delete only after confirmation, using macOS Trash. Preserve original learning assets and do not automatically grant external-folder access to independent sessions.
- App modification: user-initiated in-app requests may cause the official subscription CLI to propose and perform app source changes; includes build/restart and recovery validation. Full MVP requirement REQ-011, SPEC-005, WBS-031. No unrequested autonomous self-modification.
- QA: feature-based human QA only; no fixed usage duration or minimum repetition count. STT engine quality criteria are decided in WBS-021.
- Delivery target: full MVP within 48–72 hours from development kickoff. This is a target, not evidence of technical feasibility or completion.

## Material inventory evidence · 2026-11-01

Read-only LearningX module inventory through the user-provided archive wrapper:
- 15 modules; 27 PDF items (18 exposed, 9 not yet open).
- 32 movie items (20 exposed, 12 not yet open).
- 28 assignment module items; assignment attachment inventory was not queried.

Local archive comparison:
- 18 weekly PDFs; filenames match all 18 exposed online PDFs, with no missing names.
- 20 OPUS audio files, 20 SRT files, 20 transcript JSON files and 60 Markdown derivatives.
- 16 PDFs in the separate user assignment folder; these are not counted as source lecture PDFs.
- Announcement attachments locally include 1 PNG and 2 PDFs.

Confirmed by user: PDF-first document support for A. PNG announcement support remains a proposal. Audio/transcript files provide B test samples. Audio files do not establish preservation of original video. No PPT/HWP requirement was observed in this inventory.

Limits: module metadata and filenames only; no fresh binary downloads, checksum comparison, PDF text-extraction test, scan classification or content-quality check. Announcement and assignment attachments on the server were not exhaustively queried. The legacy archive implementation was used only for this authorized investigation; no code was copied into the product. Recorder implementation files were not consulted.
