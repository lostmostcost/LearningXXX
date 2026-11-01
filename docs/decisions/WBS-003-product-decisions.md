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

## Pending

- Actual course material formats, based on a source inventory.
- Translation languages.
- Allowed file creation/edit/delete scope and recovery policy.
- Meaning and scope of manual app modification.
- Real-use period, samples, measurement method and QA acceptance thresholds.

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

Recommendation, pending user decision: PDF-first document support for A; consider PNG announcement attachments. Audio/transcript files provide B test samples. Audio files do not establish preservation of original video. No PPT/HWP requirement was observed in this inventory.

Limits: module metadata and filenames only; no fresh binary downloads, checksum comparison, PDF text-extraction test, scan classification or content-quality check. Announcement and assignment attachments on the server were not exhaustively queried. The legacy archive implementation was used only for this authorized investigation; no code was copied into the product. Recorder implementation files were not consulted.
