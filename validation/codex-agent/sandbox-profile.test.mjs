import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  codexPermissionConfig,
  permissionProfileName,
} from "./sandbox-profile.mjs";

function overrides(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    assert.equal(arguments_[index], "-c");
    const override = arguments_[index + 1];
    const separator = override.indexOf("=");
    values.set(override.slice(0, separator), override.slice(separator + 1));
  }
  return values;
}

test("builds one least-privilege filesystem, environment, and socket policy", () => {
  const workspace = path.resolve("/acceptance/workspace");
  const fixture = path.join(workspace, "site");
  const state = path.resolve("/acceptance/state");
  const prefix = path.resolve("/acceptance/prefix");
  const controlSocket = path.join(state, "control.sock");
  const binary = path.join(prefix, "bin", "htmlview");
  const nodeBinary = path.resolve("/runtime/bin/node");
  const config = overrides(
    codexPermissionConfig({
      workspace,
      fixture,
      state,
      prefix,
      controlSocket,
      binary,
      nodeBinary,
      runtimeReadRoots: [path.resolve("/runtime/config")],
    }),
  );
  const profile = `permissions.${permissionProfileName}`;
  const filesystem = config.get(`${profile}.filesystem`);
  const sockets = `{${JSON.stringify(controlSocket)}="allow"}`;

  assert.equal(
    config.get("default_permissions"),
    JSON.stringify(permissionProfileName),
  );
  for (const expected of [
    '":minimal"="read"',
    '":workspace_roots"={"."="read","site"="write"}',
    `${JSON.stringify(state)}="write"`,
    `${JSON.stringify(prefix)}="read"`,
    `${JSON.stringify(path.dirname(nodeBinary))}="read"`,
    `${JSON.stringify(path.resolve("/runtime/config"))}="read"`,
  ])
    assert.equal(filesystem.includes(expected), true, `missing ${expected}`);
  assert.equal(config.get(`${profile}.network.unix_sockets`), sockets);
  assert.equal(config.get("features.network_proxy.unix_sockets"), sockets);
  assert.equal(config.get("features.network_proxy.enabled"), "true");
  assert.equal(config.get("shell_environment_policy.inherit"), '"none"');
  assert.equal(
    config
      .get("shell_environment_policy.set")
      .includes(
        `${JSON.stringify("HTMLVIEW_STATE_DIR")}=${JSON.stringify(state)}`,
      ),
    true,
  );
  assert.equal(config.get("approval_policy"), '"never"');
  assert.equal(config.get("web_search"), '"disabled"');
});

test("rejects a writable fixture outside the workspace", () => {
  assert.throws(
    () =>
      codexPermissionConfig({
        workspace: path.resolve("/acceptance/workspace"),
        fixture: path.resolve("/acceptance/outside"),
        state: path.resolve("/acceptance/state"),
        prefix: path.resolve("/acceptance/prefix"),
        controlSocket: path.resolve("/acceptance/state/control.sock"),
        binary: path.resolve("/acceptance/prefix/bin/htmlview"),
        nodeBinary: path.resolve("/runtime/bin/node"),
      }),
    /fixture must be a child/,
  );
});
