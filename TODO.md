# To do

Agents:

- **Signed binaries.** nuthatch serves agent binaries signed by a key
  the agent was installed with, and agents refuse others. Needed before
  `[agents] update = "auto"` is safe where it matters: today whoever can
  change the binaries in `[agents] bin` can change every agent.
- **Going back.** An agent whose new binary passes `--version` but then
  cannot connect returns to the one before it.
- **Windows.** Agents on Windows update themselves as on Linux; today
  they are installed again.
- **Enrolment.** Agents that join without nuthatch reaching the host
  first.
- **Ansible.** Installs and changes on hosts run by Ansible in a
  container, beside the SSH install.
