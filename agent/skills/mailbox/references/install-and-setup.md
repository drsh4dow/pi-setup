# Installation and setup

Read this file only when Himalaya is not installed. Complete installation
and initial account setup, then return to the main skill.

## Install

Choose one method appropriate to the machine.

### macOS

With Homebrew installed:

```bash
brew install himalaya
```

### Arch Linux

```bash
sudo pacman -S himalaya
```

### Other Linux distributions

Use the distribution's Himalaya package when available. Otherwise use the
upstream binary installer, which installs the latest release.

Download it to a temporary directory and inspect it before execution:

```bash
install_dir=$(mktemp -d "${TMPDIR:-/tmp}/himalaya-install.XXXXXX")

curl -fL \
  https://raw.githubusercontent.com/pimalaya/himalaya/master/install.sh \
  -o "$install_dir/install.sh"
```

After reviewing the downloaded script:

```bash
PREFIX="$HOME/.local" sh "$install_dir/install.sh"
export PATH="$HOME/.local/bin:$PATH"
```

Ensure `$HOME/.local/bin` is also on PATH for future shells. Remove the
downloaded installer and its temporary directory after successful installation.

For unsupported platforms or custom backend features, consult the
[upstream installation instructions](https://github.com/pimalaya/himalaya#installation).

### Verify the binary

```bash
command -v himalaya
himalaya --version
himalaya --help
```

The main skill's examples target v2.1. If the installed version differs,
check its help before applying those examples.

## Configure an account

Run this in a human-operated terminal, not a non-interactive background job:

```bash
himalaya configure
```

The wizard discovers provider settings, tests the account, and offers to
save or append its configuration. Supply the requested email address,
server details, and authentication source. Review discovered settings
against the provider's documentation.

Himalaya v2 reads credentials from an external command or a literal value.
Prefer an external secret manager:

- Linux: an existing manager such as `pass`, `gopass`, or `secret-tool`.
- macOS: the login Keychain through `security`, or an existing secret manager.

Store the credential before selecting its lookup command in the wizard.
Himalaya reads that credential; it does not populate the secret store.
Keep passwords and tokens out of chat, shell history, and committed files.

For OAuth, use an external token helper that obtains and refreshes access
tokens. Himalaya v2 does not perform the OAuth authorization flow itself.
Complete provider authorization in the browser when required.

### Provider requirements

- Gmail IMAP/SMTP requires an app password where available, or OAuth.
  The normal Google account password does not work. App passwords require
  two-step verification and may be restricted by account policy.
- Microsoft accounts generally require OAuth.
- Other providers may require app-specific passwords or explicit
  IMAP/SMTP enablement.

For Gmail over IMAP/SMTP, the standard TLS endpoints are
`imaps://imap.gmail.com:993` and `smtps://smtp.gmail.com:465`.
Use the full email address as the username.

## Configuration location

The documented search paths are:

1. `$XDG_CONFIG_HOME/himalaya/config.toml`
2. `$HOME/.config/himalaya/config.toml`
3. `$HOME/.himalayarc`

Use `--config /path/to/config.toml` to select a specific file.
Preserve any existing accounts.

If discovery does not cover the provider, use the
[documented configuration sample](https://github.com/pimalaya/himalaya/blob/v2.1.0/config.sample.toml)
as a reference. Match the sample to the installed version rather than
copying a v1 configuration into v2.

## Verify the account

```bash
himalaya --json account list

account='ACCOUNT_NAME'
himalaya --account "$account" --json account check
himalaya --account "$account" --json mailbox list
```

Select an inbox ID from the mailbox result:

```bash
himalaya --account "$account" --json envelope list \
  --mailbox 'INBOX_ID' --page 1 --page-size 5
```

Setup is complete when the intended account is listed, its required
backends pass their checks, and its mailbox can be listed. An empty inbox
is valid. Sending an actual test email is a separate action requiring the
user's request.
