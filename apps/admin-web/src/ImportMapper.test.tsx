import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImportMapper } from "./screens/ImportMapper.js";
import { api } from "./api.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const preview = {
  headers: ["email"],
  sample: [{ email: "reader@example.com" }],
  rowCount: 120000,
  fingerprint: "fp-large",
  suggested: { columns: { email: { kind: "email" as const } } },
  saved: [],
  problems: [],
};

test("large files upload, preview from storage, and queue the confirmed mapping", async () => {
  vi.spyOn(api, "lists").mockResolvedValue([]);
  const upload = vi.spyOn(api, "uploadImportFile").mockResolvedValue({
    batchId: "imp_2026-09-15T12:00:00.000Z_ab12cd34",
    key: "imports/acme/imp_2026-09-15T12:00:00.000Z_ab12cd34",
    url: "https://s3.example/upload",
  });
  const uploadPreview = vi.spyOn(api, "importUploadPreview").mockResolvedValue(preview);
  const queued = vi.spyOn(api, "importAsync").mockResolvedValue({
    batchId: "imp_2026-09-15T12:00:00.000Z_ab12cd34",
    status: "running",
  });
  vi.spyOn(api, "importBatches").mockResolvedValue([]);

  const user = userEvent.setup();
  render(<ImportMapper org="acme" />);
  const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "export.jsonl.gz", {
    type: "application/gzip",
  });
  const fileInput = document.querySelector('input[type="file"]');
  expect(fileInput).not.toBeNull();
  await user.upload(fileInput as HTMLInputElement, file);
  expect(upload).not.toHaveBeenCalled();
  const previewButton = screen.getByRole("button", { name: "Preview mapping" });
  await user.click(previewButton);
  await screen.findByText(/1 columns, 120000 rows/);
  expect(upload).toHaveBeenCalledWith("acme", file);
  expect(uploadPreview).toHaveBeenCalledWith("acme", "imp_2026-09-15T12:00:00.000Z_ab12cd34", "implicit");

  await user.click(screen.getByRole("button", { name: "Import" }));
  await screen.findByText(/Import queued/);
  expect(queued).toHaveBeenCalledWith("acme", expect.objectContaining({
    batchId: "imp_2026-09-15T12:00:00.000Z_ab12cd34",
    plan: preview.suggested,
    status: "pending",
  }));
});
