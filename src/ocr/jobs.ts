import { randomUUID } from "node:crypto";

export type OcrJobType = "notebook" | "renumber";
export type OcrJobState = "queued" | "running" | "succeeded" | "failed";
export type OcrJobErrorCode = "job_missing";

export class OcrJobError extends Error {
  readonly code: OcrJobErrorCode;

  constructor(code: OcrJobErrorCode, message: string) {
    super(message);
    this.name = "OcrJobError";
    this.code = code;
  }
}

export interface OcrNotebookInput {
  identifier: string;
  pages?: number[];
  force?: boolean;
}

export interface OcrRenumberInput {
  notebook_id: string;
}

export type OcrJobInput = OcrNotebookInput | OcrRenumberInput;

interface OcrJobBase {
  id: string;
  type: OcrJobType;
  state: OcrJobState;
  queuedAt: string;
  updatedAt: string;
  error?: string;
}

export interface OcrNotebookJob extends OcrJobBase {
  type: "notebook";
  input: OcrNotebookInput;
}

export interface OcrRenumberJob extends OcrJobBase {
  type: "renumber";
  input: OcrRenumberInput;
}

export type OcrJob = OcrNotebookJob | OcrRenumberJob;

export interface OcrQueuedJob {
  job_id: string;
  state: Extract<OcrJobState, "queued">;
  type: OcrJobType;
  queued_at: string;
}

export interface OcrJobQueueOptions {
  createId?: () => string;
  now?: () => Date;
}

export interface OcrTools {
  ocr_notebook(input: OcrNotebookInput): OcrQueuedJob;
  ocr_status(jobId: string): OcrJob;
  ocr_renumber_notebook(notebookId: string): OcrQueuedJob;
}

export class OcrJobQueue {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, OcrJob>();

  constructor(options: OcrJobQueueOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  enqueueNotebook(input: OcrNotebookInput): OcrQueuedJob {
    const queuedAt = this.now().toISOString();
    const job: OcrNotebookJob = {
      id: this.createId(),
      type: "notebook",
      state: "queued",
      queuedAt,
      updatedAt: queuedAt,
      input: {
        identifier: input.identifier,
        ...(input.pages === undefined ? {} : { pages: [...input.pages] }),
        ...(input.force === undefined ? {} : { force: input.force })
      }
    };
    this.jobs.set(job.id, job);
    return toQueuedJob(job);
  }

  enqueueRenumber(notebookId: string): OcrQueuedJob {
    const queuedAt = this.now().toISOString();
    const job: OcrRenumberJob = {
      id: this.createId(),
      type: "renumber",
      state: "queued",
      queuedAt,
      updatedAt: queuedAt,
      input: { notebook_id: notebookId }
    };
    this.jobs.set(job.id, job);
    return toQueuedJob(job);
  }

  getStatus(jobId: string): OcrJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw new OcrJobError("job_missing", `Unknown OCR job: ${jobId}`);
    }
    return cloneJob(job);
  }
}

export function createOcrTools(queue: OcrJobQueue): OcrTools {
  return {
    ocr_notebook: (input) => queue.enqueueNotebook(input),
    ocr_status: (jobId) => queue.getStatus(jobId),
    ocr_renumber_notebook: (notebookId) => queue.enqueueRenumber(notebookId)
  };
}

function cloneJob(job: OcrJob): OcrJob {
  if (job.type === "notebook") {
    return {
      ...job,
      input: {
        identifier: job.input.identifier,
        ...(job.input.pages === undefined ? {} : { pages: [...job.input.pages] }),
        ...(job.input.force === undefined ? {} : { force: job.input.force })
      }
    };
  }
  return {
    ...job,
    input: { notebook_id: job.input.notebook_id }
  };
}

function toQueuedJob(job: OcrJob): OcrQueuedJob {
  return {
    job_id: job.id,
    state: "queued",
    type: job.type,
    queued_at: job.queuedAt
  };
}
