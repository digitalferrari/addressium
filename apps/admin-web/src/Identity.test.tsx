import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Identity } from "./screens/Identity.js";
import { absoluteApiUrl, api } from "./api.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("Identity describes and copies the organization's own JWKS URL", async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, "writeText");
  vi.spyOn(api, "orgIdentity").mockResolvedValue({
    orgId: "acme", subscriberPoolId: "subscriber-pool",
    magicLink: {
      enabled: true, jwksPath: "/orgs/acme/.well-known/jwks.json", kid: "key-1",
      keyCount: 1,
      kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-1", issuer: "acme", audience: "readers",
    },
  });
  render(<Identity org="acme" />);
  await user.click(await screen.findByRole("button", { name: "Copy JWKS URL" }));
  expect(clipboard).toHaveBeenCalledWith(absoluteApiUrl("/orgs/acme/.well-known/jwks.json"));
  expect(screen.getByText(/JWKS endpoint is scoped to this organization/)).toBeInTheDocument();
  expect(screen.queryByText(/inside the shared JWKS/)).not.toBeInTheDocument();
});

test("disabled magic links describe an empty JWKS without promising SES readiness", async () => {
  vi.spyOn(api, "orgIdentity").mockResolvedValue({ orgId: "acme", magicLink: { enabled: false } });
  render(<Identity org="acme" />);
  expect(await screen.findByText(/public JWKS endpoint returns an empty key set/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Copy JWKS URL" })).not.toBeInTheDocument();
  expect(screen.queryByText(/every list sends normally/)).not.toBeInTheDocument();
});
