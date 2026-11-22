# KNUE Calendar Tools

Two independently deployed Cloudflare Workers in one repository.

| App | Input | Output |
| --- | --- | --- |
| [ICS calendar](apps/ics-calendar/) | Official KNUE academic calendar | Existing ICS subscription and status endpoint |
| [Event harvester](apps/event-harvester/) | KNUE announcements RSS | Google Calendar events and Telegram notifications |

Run npm commands from the corresponding app directory. Each app keeps its own
lockfile, Wrangler configuration, and CI workflow. The [harvester runbook](apps/event-harvester/docs/runbook.md)
covers staging, snapshot import, and cutover. [Migration design](docs/design/knue-calendar-workers.md).
