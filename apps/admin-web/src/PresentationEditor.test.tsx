import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api, type AdminList, type ListPresentation } from "./api.js";
import { PresentationEditor } from "./screens/PresentationEditor.js";
// The real constant `publicListView` renders for a list with no `presentation`,
// imported rather than restated so the editor's local mirror cannot drift from
// it silently. Note this resolves to `@addressium/domain`'s BUILT output, and
// root `npm test` does not run admin-web's vitest — so it catches drift on an
// admin-web test run that follows a domain build, not the instant the domain
// source is edited.
import { UNCONFIGURED_PRESENTATION } from "@addressium/domain";

const TOGGLES: ListPresentation = {
  showFrequency: true,
  showSendTime: false,
  showDescription: false,
  showReaderCount: true,
  showFreePaidCount: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount(presentation?: ListPresentation) {
  const lists: AdminList[] = [
    { orgId: "acme", listId: "weekly", name: "Weekly", presentation },
    { orgId: "acme", listId: "unset", name: "Unset" },
  ];
  vi.spyOn(api, "lists").mockResolvedValue(lists);
  const save = vi.spyOn(api, "setPresentation").mockResolvedValue({ ok: true } as never);
  const user = userEvent.setup();
  render(<PresentationEditor org="acme" />);
  await screen.findByRole("option", { name: "Weekly (weekly)" });
  await user.selectOptions(screen.getByRole("combobox"), "weekly");
  return { user, save };
}

test("saving a checkbox change does not materialize absent labels (#262)", async () => {
  const { user, save } = await mount(TOGGLES);
  expect(screen.getByLabelText("Frequency label")).toHaveValue("");
  expect(screen.getByLabelText("Send-time label")).toHaveValue("");
  expect(screen.getByLabelText("Show send time")).not.toBeChecked();
  await user.click(screen.getByLabelText("Show description"));
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", {
    ...TOGGLES, showDescription: true,
  }));
  expect(save.mock.calls[0]![2]).not.toHaveProperty("frequencyLabel");
  expect(save.mock.calls[0]![2]).not.toHaveProperty("sendTimeLabel");
});

test("saving an untouched unconfigured list writes what it already renders (#262)", async () => {
  const { user, save } = await mount();
  // The form shows the real unconfigured state, not a more generous default.
  expect(screen.getByLabelText("Show frequency")).not.toBeChecked();
  expect(screen.getByLabelText("Show send time")).not.toBeChecked();
  expect(screen.getByLabelText("Show description")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", UNCONFIGURED_PRESENTATION));
});

test("saving a list with no presentation does not save example labels", async () => {
  const { user, save } = await mount();
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]![2]).not.toHaveProperty("frequencyLabel");
  expect(save.mock.calls[0]![2]).not.toHaveProperty("sendTimeLabel");
});

test("unchecking a saved toggle saves it off rather than dropping it as unset", async () => {
  // The booleans are object-keyed, not presence-keyed: an unchecked box is a
  // real `false` the operator chose, and must round-trip as one.
  const { user, save } = await mount(TOGGLES);
  await user.click(screen.getByLabelText("Show frequency"));
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", {
    ...TOGGLES, showFrequency: false,
  }));
});

test("existing labels, including an explicit empty string, survive an unrelated edit", async () => {
  const presentation = { ...TOGGLES, frequencyLabel: "Weekly", sendTimeLabel: "" };
  const { user, save } = await mount(presentation);
  expect(screen.getByLabelText("Frequency label")).toHaveValue("Weekly");
  await user.click(screen.getByLabelText("Show free / paid count"));
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", {
    ...presentation, showFreePaidCount: true,
  }));
});

test("entering even the example label saves it without filling the other label", async () => {
  const { user, save } = await mount(TOGGLES);
  await user.type(screen.getByLabelText("Frequency label"), "Daily");
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", {
    ...TOGGLES, frequencyLabel: "Daily",
  }));
});

test("operators can clear a saved label and edit the send-time label", async () => {
  const { user, save } = await mount({ ...TOGGLES, frequencyLabel: "Weekly" });
  await user.clear(screen.getByLabelText("Frequency label"));
  await user.type(screen.getByLabelText("Send-time label"), "Friday afternoons");
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("acme", "weekly", {
    ...TOGGLES, frequencyLabel: "", sendTimeLabel: "Friday afternoons",
  }));
});

test("switching lists discards draft labels and preserves the new list's omissions", async () => {
  const { user, save } = await mount({ ...TOGGLES, frequencyLabel: "Weekly" });
  await user.type(screen.getByLabelText("Send-time label"), "Friday afternoons");
  await user.selectOptions(screen.getByRole("combobox"), "unset");
  expect(screen.getByLabelText("Frequency label")).toHaveValue("");
  expect(screen.getByLabelText("Send-time label")).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "Save toggles" }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![1]).toBe("unset");
  expect(save.mock.calls[0]![2]).not.toHaveProperty("frequencyLabel");
  expect(save.mock.calls[0]![2]).not.toHaveProperty("sendTimeLabel");
});
