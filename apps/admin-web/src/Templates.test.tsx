import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Templates } from "./screens/Templates.js";
import { api, type Template } from "./api.js";

// Match the real editor's mount-only seed without loading GrapesJS in jsdom.
vi.mock("./VisualEditor.js", () => ({
  VisualEditor: ({ initialMjml, onApply }: { initialMjml: string; onApply: (source: string) => void }) => {
    const [body, setBody] = useState(initialMjml);
    return <>
      <textarea aria-label="Visual body" value={body} onChange={(e) => setBody(e.target.value)} />
      <button onClick={() => onApply(body)}>Apply to template</button>
    </>;
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("selecting and reloading visual templates applies and saves the selected body", async () => {
  const templates = [
    { orgId: "acme", templateId: "first", name: "First", mode: "visual", source: "First body", version: 1 },
    { orgId: "acme", templateId: "second", name: "Second", mode: "visual", source: "Second body", version: 1 },
  ] as Template[];
  vi.spyOn(api, "templates").mockResolvedValue(templates);
  const save = vi.spyOn(api, "saveTemplate").mockResolvedValue(templates[1]!);
  const user = userEvent.setup();
  render(<Templates org="acme" />);
  const first = await screen.findByRole("row", { name: /First/ });
  const second = screen.getByRole("row", { name: /Second/ });
  await user.click(within(first).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Visual body")).toHaveValue("First body");
  await user.click(within(second).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Visual body")).toHaveValue("Second body");
  await user.type(screen.getByLabelText("Visual body"), " unsaved edits");
  await user.click(within(second).getByRole("button", { name: "Edit" }));
  expect(screen.getByLabelText("Visual body")).toHaveValue("Second body");
  await user.click(screen.getByRole("button", { name: "Apply to template" }));
  await user.click(screen.getByRole("button", { name: "Save template" }));
  await screen.findByText(/Saved "second"/);
  expect(save).toHaveBeenCalledWith({ orgId: "acme", templateId: "second", name: "Second", mode: "visual", source: "Second body" });
  expect(screen.getByText(/Saving changes here does not update/)).toHaveTextContent(/including recurring sends/);
});
