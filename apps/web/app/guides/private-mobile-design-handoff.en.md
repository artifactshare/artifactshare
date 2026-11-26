# Keep a mobile design document private when handing it to a PC

> Share a design document made on mobile so only you can see it, then continue it on a PC.

There are only two steps:

1. Have your mobile agent post it with `share ./design.md --home --visibility private`.
2. Open the returned share link on your PC and continue.

## A post with `--visibility private` is visible only to you

Have the agent on your mobile device run:

```bash
npx --yes @artifactshare/cli share ./design.md --home --visibility private
```

You can choose the sharing range per post. Only you can open a post made with `--visibility private`. Without it, the default is the workspace, so other workspace members can see it too.

On success the command returns the share link. That URL is all the handoff needs.

## On the PC, opening the URL is enough to continue

Open the returned URL in a browser on your PC, or pass it to your PC agent with `open <artifact-url>`. The document made on mobile and the editing or implementation on the PC stay attached to the same file.

## To make every post private, change the default

If you don't want to add `--visibility private` to every home post, change the default sharing range:

```bash
npx --yes @artifactshare/cli config set home_audience private --scope user
```

From then on, new home posts from this CLI environment are private even without the flag. The setting is stored per device and is not synchronized to your Artifact Share account, so if you also post from a PC, run the same command there.

## If posts still aren't private, a repository setting takes precedence

If posts come out workspace-visible even after changing the default, the repository's `home_audience` setting is overriding your user setting. Check the value actually in effect with:

```bash
npx --yes @artifactshare/cli config get home_audience --scope effective
```

A repository setting affects everyone who uses that repository, so agree with the participants before changing it.

For the complete command surface, see the [CLI reference](https://artifactshare.com/guides/cli). For product changes, see [Updates](https://artifactshare.com/updates).
