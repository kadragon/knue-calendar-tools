## Sprint Contract: Run KNUE calendar tools on Cloudflare

**Scope:** Import both app histories. Run the harvester as a scheduled Worker with
AI Gateway Chat Completions and Durable Object key-value state.

**Non-Goals:** Production cutover and original repository retirement.

**Acceptance Criteria:**

- AC-1: Build and test both apps independently. Preserve the ICS Worker configuration.
- AC-2: Use the authenticated Gateway for structured text and image extraction.
- AC-3: Repeatable import preserves existing records, cursors, and failure counts.
- AC-4: Overlapping runs, interrupted multi-event writes, and retries keep calendar events unique and cursors safe.
- AC-5: Exercise the scheduled handler with local Cloudflare storage and stubbed external services. Document staging and cutover.

**Evaluator:** Independent pre-edit exploration and post-implementation review,
plus executable regression checks.

**Done when:** All local acceptance checks pass and the cutover steps are documented.
