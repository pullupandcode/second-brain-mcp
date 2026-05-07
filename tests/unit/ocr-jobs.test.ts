import { describe, expect, test } from "vitest";

import { createOcrTools, OcrJobError, OcrJobQueue } from "../../src/ocr/jobs.js";

describe("OCR job contracts", () => {
  test("queues notebook OCR jobs with stable status payloads", () => {
    const queue = new OcrJobQueue({
      createId: () => "job-1",
      now: () => new Date("2026-05-07T12:00:00.000Z")
    });
    const tools = createOcrTools(queue);

    const queued = tools.ocr_notebook({
      identifier: "rmnotebook:abc",
      pages: [1, 3],
      force: true
    });

    expect(queued).toEqual({
      job_id: "job-1",
      state: "queued",
      type: "notebook",
      queued_at: "2026-05-07T12:00:00.000Z"
    });
    expect(tools.ocr_status("job-1")).toEqual({
      id: "job-1",
      type: "notebook",
      state: "queued",
      queuedAt: "2026-05-07T12:00:00.000Z",
      updatedAt: "2026-05-07T12:00:00.000Z",
      input: {
        identifier: "rmnotebook:abc",
        pages: [1, 3],
        force: true
      }
    });
  });

  test("queues renumber jobs separately from OCR jobs", () => {
    const queue = new OcrJobQueue({
      createId: () => "renumber-1",
      now: () => new Date("2026-05-07T12:05:00.000Z")
    });
    const tools = createOcrTools(queue);

    expect(tools.ocr_renumber_notebook("rmnotebook:abc")).toEqual({
      job_id: "renumber-1",
      state: "queued",
      type: "renumber",
      queued_at: "2026-05-07T12:05:00.000Z"
    });
    expect(tools.ocr_status("renumber-1")).toMatchObject({
      id: "renumber-1",
      type: "renumber",
      input: { notebook_id: "rmnotebook:abc" }
    });
  });

  test("rejects unknown OCR job ids", () => {
    const tools = createOcrTools(new OcrJobQueue());

    expect(() => tools.ocr_status("missing")).toThrow(OcrJobError);
    expect(() => tools.ocr_status("missing")).toThrow("Unknown OCR job: missing");
  });
});
