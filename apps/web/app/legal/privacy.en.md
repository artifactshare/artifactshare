**Last updated:** 2026-07-24

Artifact Share is provided by TechTalk, Inc. The service lets signed-in users
upload HTML and Markdown files, store them in Artifact Share infrastructure, and
share them through app-managed access controls.

## Information We Collect

- Google sign-in profile data: email, verification status, display name,
  profile image, account identifier, and Workspace domain when present.
- Uploaded file content and metadata: file name, size, hash, versions,
  visibility, and explicit email grants.
- View records: file ID, viewer user ID when signed in, timestamp, and
  privacy-preserving request metadata hashes.

## How We Use Information

We use the data to authenticate users, enforce access controls, store and display
files, show view counts, operate the service, and respond to support or legal
requests. Uploaded file bodies are stored in Cloudflare R2 and are deleted from
that storage when the owning user removes the file.

## Google Data

Artifact Share uses Google for sign-in and for analytics (see Analytics below).
Sign-in uses the OIDC scopes `openid`, `email`, and `profile`. We do not request
permission to read or write user files.

## Analytics

Artifact Share uses Google Analytics 4, a web analytics service provided by
Google, to understand how the service is used. For this purpose, we send the
following information to Google:

- The address of the page you viewed, and the page you came from
- The time of your visit
- An approximate location inferred from the IP address of your visit
- Your device and browser type, screen size, and language setting
- An identifier generated through cookies to distinguish visitors
- For signed-in users, an additional identifier derived by hashing an
  internal account identifier, used to connect your activity before and
  after signing in, and across sessions and devices

This identifier is derived by hashing an internal account identifier used
within Artifact Share. It is not your email address, name, or the internal
account identifier itself, and it cannot be reversed to any of them without a
secret that only Artifact Share holds. On its own, it does not directly
identify you. However, because it lets the same user's activity be connected
within Google Analytics, we do not treat the risk of re-identification as
zero.

The recipient is Google LLC (United States). For details on how Google
handles this data, see Google's [Privacy Policy](https://policies.google.com/privacy)
and ["How Google Uses Information from Sites or Apps That Use Our Services"](https://policies.google.com/technologies/partner-sites).

Visitors from the EU, the EEA, and the UK are asked for consent before
browser-based analytics starts, and browser-based analytics — including the
identifier described above — does not run until consent is given. In other
regions, analytics runs by default and can be turned off at any time. You can
change this setting from "Analytics settings" in the page footer or the
shared page, or by using Google's [Analytics Opt-out Browser Add-on](https://tools.google.com/dlpage/gaoptout).
Withdrawing consent, or turning analytics off, stops future collection; it
does not delete data already sent to Google.

Artifact Share also measures the first time a signed-in user posts a file
through the CLI or MCP. The CLI and MCP do not go through a browser, so the
browser-based analytics described above cannot capture this. Instead, our
server sends an event directly to Google using the GA4 Measurement Protocol, a
mechanism for sending data to Google without a browser. This event includes
only the event name, a value showing the channel used (web, CLI, or MCP), and
an identifier created the same way as above. It does not include your email
address, name, company name, file contents, or credentials.

This send does not use cookies. It is a server-to-server call that does not
use any browser storage either. We measure it as your own signed-in account's
action, to understand where visitors drop off between viewing a shared file
and posting their own. The consent described above governs browser-based
analytics and the cookies it uses. It does not apply to this cookie-less,
server-side measurement.

## Cookies

Artifact Share uses cookies for the following purposes:

- Keeping you signed in (required to use the service)
- Remembering your display language and theme (for example, `__as_locale`)
- Recording your analytics choice (`__as_analytics_consent`, stored for one
  year; this cookie may be set even before you consent to analytics, since it
  exists to record your choice)
- Analytics (only when you have consented, or have not opted out; uses
  cookies set by Google, such as `_ga`)

Cookies for sign-in, display preferences, and recording your choice are used
to make the service work correctly. Analytics cookies can be turned off at any
time using the setting described above.

## Contact

Privacy questions can be sent to support@artifactshare.com.
