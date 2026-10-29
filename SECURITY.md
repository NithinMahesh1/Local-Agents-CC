# Security Policy

This document describes the security practices for Local-Agents-CC.

## Supported versions

Only the latest published version receives security fixes. Update your installation before you report a vulnerability using this command:

```bash
npm install -g local-agents-cc@latest
```

## Report a vulnerability

Use the "Report a vulnerability" feature in the repository's Security tab: https://github.com/NithinMahesh1/Local-Agents-CC/security/advisories/new. This method sends a private report.

Do not open a public issue to report a vulnerability. Do not ask for a private contact in a public issue.

Do not include API keys, your AI server's address, or private code in your report. Remove these details from logs and examples before you send them.

Include the following information in your report:

- The `local-agents-cc` version.
- The operating system.
- The Node.js version.
- The steps to reproduce the vulnerability.
- The impact of the vulnerability.
- A suggested fix, if you have one.

The maintainer will confirm the report. The maintainer will check the report and agree on the time for public disclosure with you.

## What the project protects

- `spark-router` listens on `127.0.0.1` only. Other computers cannot reach it.
- The router answers only requests addressed to `127.0.0.1` or `localhost` via the Host header. This blocks DNS-rebinding attacks. A DNS-rebinding attack is when a web page makes your browser send requests to the router using a different name.
- The router reads the model name only from JSON requests. A web page cannot send a JSON request to another site without the browser sending a CORS preflight request first. A CORS preflight request is a check the browser performs before sending certain requests. This prevents a web page from using your AI server through the router without your knowledge.
- The router removes the `Authorization`, `x-api-key`, and `Cookie` headers that Claude Code sends. This ensures your Claude login does not go to the AI server.
- The Anthropic address is fixed in the code. No setting can send your Claude login to a different address.
- The AI server's API key comes from a file. The key is never in the code and is never logged. Log lines only include the time, method, path, model, destination, status, and duration. Logs do not hold headers, query strings, or message text.
- The package has no runtime dependencies. A runtime dependency is an external software component that a program needs to run.

## What the project does not protect

- Other programs that run as your user. These programs can use the router and your AI server. They can also read your key file.
- The network between your computer and your AI server. If you use an `http://` address, the AI server key and your requests cross your network as plain text. Plain text is data that is not encrypted. Keep the AI server on a network you trust. Allow its port only from that network. Use an `https://` address if your server supports it.
- The AI server itself. Anyone who runs the AI server can see every request that goes to it.
- Your data choices. Requests for the local model go to your AI server. In `--all-local` mode, everything the session reads goes to your AI server. Do not use credentials, connection strings, or customer data in these sessions.
