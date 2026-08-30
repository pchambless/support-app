Authorization allowlist for internal tools (support, wf_admin) - not a login system.

Answers "is this person allowed in," not "prove you are this person." For a single
trusted user today, network-level trust (SSH tunnel/VPN, or the same
X-Webhook-Secret pattern already used for n8n) is the honest authentication story -
no login screen needed. This file starts earning its keep once a second real person
needs telling apart from the first; at that point, check a submitted email/password
or magic link against this list before issuing a session.

Shared across apps deliberately, not duplicated per app - the humans are the same
people, `apps` just scopes which tools they're allowed into. Not a customer/tenant
model (see memory/project_app_template_epic.md for why that distinction matters).

Update by editing authorized-users.json directly and committing - git is the audit
trail (who was added/removed, when, by whom).
