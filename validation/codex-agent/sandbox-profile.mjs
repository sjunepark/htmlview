import path from "node:path";

export const permissionProfileName = "htmlview_acceptance";

function quote(value) {
  return JSON.stringify(value);
}

function inlineTable(entries) {
  return `{${entries
    .map(([key, value]) => `${quote(key)}=${value}`)
    .join(",")}}`;
}

export function codexPermissionConfig({
  workspace,
  fixture,
  state,
  prefix,
  controlSocket,
  binary,
  nodeBinary,
  runtimeReadRoots = [],
}) {
  const writableFixture = path.relative(workspace, fixture);
  if (
    writableFixture === "" ||
    writableFixture === ".." ||
    writableFixture.startsWith(`..${path.sep}`) ||
    path.isAbsolute(writableFixture)
  )
    throw new Error("The Codex fixture must be a child of its workspace");

  const workspaceRules = inlineTable([
    [".", quote("read")],
    [writableFixture.split(path.sep).join("/"), quote("write")],
  ]);
  const explicitRoots = new Map([
    [state, "write"],
    [prefix, "read"],
    [path.dirname(nodeBinary), "read"],
    ...runtimeReadRoots.map((root) => [root, "read"]),
  ]);
  const filesystemRules = inlineTable([
    [":minimal", quote("read")],
    [":workspace_roots", workspaceRules],
    ...[...explicitRoots].map(([root, access]) => [root, quote(access)]),
  ]);
  const shellPath = [
    path.dirname(binary),
    path.dirname(nodeBinary),
    "/usr/bin",
    "/bin",
  ].join(path.delimiter);
  const shellEnvironment = inlineTable([
    ["PATH", quote(shellPath)],
    ["HTMLVIEW_STATE_DIR", quote(state)],
  ]);
  const unixSockets = inlineTable([[controlSocket, quote("allow")]]);
  const profile = `permissions.${permissionProfileName}`;

  return [
    "-c",
    `default_permissions=${quote(permissionProfileName)}`,
    "-c",
    `${profile}.filesystem=${filesystemRules}`,
    "-c",
    `${profile}.network.enabled=true`,
    "-c",
    `${profile}.network.mode=${quote("limited")}`,
    "-c",
    `${profile}.network.enable_socks5=false`,
    "-c",
    `${profile}.network.enable_socks5_udp=false`,
    "-c",
    `${profile}.network.allow_upstream_proxy=false`,
    "-c",
    `${profile}.network.allow_local_binding=false`,
    "-c",
    `${profile}.network.unix_sockets=${unixSockets}`,
    "-c",
    "features.network_proxy.enabled=true",
    "-c",
    `features.network_proxy.unix_sockets=${unixSockets}`,
    "-c",
    `shell_environment_policy.inherit=${quote("none")}`,
    "-c",
    `shell_environment_policy.set=${shellEnvironment}`,
    "-c",
    `approval_policy=${quote("never")}`,
    "-c",
    `web_search=${quote("disabled")}`,
    "-c",
    "allow_login_shell=false",
  ];
}
