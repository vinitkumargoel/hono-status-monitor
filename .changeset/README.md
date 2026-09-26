# Changesets

Every PR that changes behaviour adds a changeset: `npx changeset`, pick the bump
(patch / minor / major) and describe the change for users. The release workflow
turns pending changesets into a "Version Packages" PR (version bump +
CHANGELOG entry); merging that PR publishes to npm with provenance.
