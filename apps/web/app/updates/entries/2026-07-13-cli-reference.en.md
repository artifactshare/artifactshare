---
title: A public reference for the Artifact Share CLI
date: 2026-07-13
products: [cli, web]
kind: new
details: private-mobile-design-handoff
---

When people use a mobile development environment and an agent while travelling, they can carry a design document forward and continue the work on a PC later. Setting user-level `home_audience` to `private` keeps that in-progress document from being unintentionally shared with everyone in the workspace in this CLI environment, without requiring the who can view to be specified every time.

The new CLI reference explains how to share, update, read, comment on, and organize files from a terminal. It also documents JSON output, settings, destinations, and recovery paths so people and agents can find the right command quickly.

When no destination is specified, `share` posts to home; use user-level `home_audience` as the personal safe default, confirm its effective value, and use repository scope only for a policy agreed by all participants.
