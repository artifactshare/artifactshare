import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Each scenario names the CLI commands it exercises and, when SKILL.md alone
// is not enough, the reference an agent has to read to finish the task.
// Seeds run through the run's own CLI before the agent starts; probes collect
// local evidence after the agent's action log has been read, and verify turns
// the gathered evidence into the scenario's `task` check.
export const initialHtml =
  '<!doctype html><html lang="en"><meta charset="utf-8"><title>Sample report</title><h1>Sample report</h1><p>Draft schedule</p></html>\n'
export const expectedContent = 'Launch is ready for Friday.'
export const commentText = `The schedule line should say "${expectedContent}" instead of the draft text.`
export const appendixHtml =
  '<section><h2>Appendix</h2><p>Venue confirmed.</p></section>\n'
export const siteFiles = {
  'site/index.html':
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Status site</title><h1>Status site</h1><script src="app.js"></script></html>\n',
  'site/app.js': "document.body.append('Site loaded')\n",
}
export const versionLabel = 'Friday copy'
export const editedTitle = 'Launch report'
export const linkExpiry = '2026-12-31T00:00:00Z'
export const projectName = 'Launch room'

const outcome = (status, evidence) => ({ status, evidence })
const decide = (value, evidence) => outcome(value ? 'pass' : 'fail', evidence)
const unknown = (reason) => outcome('unknown', reason)
const current = (after) =>
  after?.versions?.find((version) => version.is_current)

export const scenarios = {
  share: {
    legacy: true,
    commands: ['share'],
    seed: [],
    prompt: () =>
      'Please share report.html using Artifact Share and give me its browser URL.',
  },
  update: {
    legacy: true,
    commands: ['update'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `Please change the schedule text in report.html to “${expectedContent}” and update the existing Artifact Share page at ${url} so people can keep using that same URL. Give me the updated page URL.`,
  },
  comments: {
    legacy: true,
    commands: ['comments'],
    seed: ['artifact', 'comment'],
    prompt: ({ url }) =>
      `Someone left comments on the shared page at ${url}. Please make the changes they asked for in report.html and update that same page. Give me the page URL.`,
  },
  append: {
    commands: ['append'],
    seed: ['artifact'],
    files: { 'appendix.html': appendixHtml },
    prompt: ({ url }) =>
      `Add appendix.html to the end of the shared page at ${url} without replacing what is already there, and keep the same URL.`,
    verify: ({ after }) =>
      after?.content === undefined || after.truncated
        ? unknown('Persisted source unavailable or truncated')
        : decide(
            after.content.includes('Draft schedule') &&
              after.content.includes('Venue confirmed.'),
            { version: after.version_id },
          ),
  },
  label: {
    commands: ['update'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `Change the schedule text in report.html to “${expectedContent}”, update the page at ${url}, and record the note “${versionLabel}” on that new version so it shows in the version history.`,
    verify: ({ after }) =>
      after?.versions
        ? decide(
            current(after)?.label === versionLabel &&
              after.content?.includes(expectedContent),
            { label: current(after)?.label ?? null },
          )
        : unknown('Version history unavailable'),
  },
  edit: {
    commands: ['edit'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `Rename the shared page at ${url} to “${editedTitle}” and let anyone with the link view it until ${linkExpiry}. Do not upload a new version.`,
    verify: ({ before, after, listItem }) =>
      listItem && after?.versions
        ? decide(
            listItem.title === editedTitle &&
              listItem.visibility === 'link' &&
              Date.parse(listItem.link_expires_at) === Date.parse(linkExpiry) &&
              after.version_id === before?.version_id,
            {
              title: listItem.title,
              visibility: listItem.visibility,
              linkExpiresAt: listItem.link_expires_at,
            },
          )
        : unknown('Artifact metadata unavailable'),
  },
  project: {
    commands: ['projects', 'edit'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `Create a project called “${projectName}” and put the shared page at ${url} in it.`,
    verify: ({ after, projects }) => {
      const created = projects?.created?.find(
        (project) => project.name === projectName,
      )
      return after && projects
        ? decide(Boolean(created) && after.project_id === created.id, {
            projectId: after.project_id,
            created: projects.created.map((project) => project.name),
          })
        : unknown('Project evidence unavailable')
    },
  },
  delete: {
    commands: ['delete'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `We no longer need the shared page at ${url}. Please delete it permanently.`,
    verify: ({ before, afterList }) =>
      afterList
        ? decide(!afterList.some((artifact) => artifact.id === before?.id), {
            id: before?.id,
          })
        : unknown('Artifact inventory unavailable'),
  },
  read: {
    commands: ['artifacts', 'open'],
    seed: ['artifact'],
    prompt: ({ url }) =>
      `What does the schedule line say on the Artifact Share page at ${url}? Quote it exactly.`,
    verify: ({ record }) =>
      decide(record.finalMessage.includes('Draft schedule'), {
        finalMessage: record.finalMessage.slice(0, 200),
      }),
  },
  resolve: {
    commands: ['resolve', 'update'],
    seed: ['artifact'],
    prompt: () =>
      `Change the schedule text in report.html to “${expectedContent}” and update my existing Artifact Share page titled “Sample report” so it keeps its URL. I don't have the link handy.`,
    verify: ({ before, after }) =>
      after?.content === undefined
        ? unknown('Persisted source unavailable')
        : decide(
            after.id === before?.id &&
              after.version_id !== before.version_id &&
              after.content.includes(expectedContent),
            { before: before?.version_id, after: after.version_id },
          ),
  },
  reply: {
    commands: ['comments'],
    reference: 'comments.md',
    seed: ['artifact', 'comment'],
    prompt: ({ url }) =>
      `There is a comment on the shared page at ${url}. Make the change it asks for in report.html and update that page, then reply in that comment thread to say it is fixed and mark the thread resolved.`,
    verify: ({ after }) => {
      const thread = after?.comments?.[0]
      return thread
        ? decide(
            after.content?.includes(expectedContent) &&
              thread.status === 'resolved' &&
              thread.reply_count > 0,
            { status: thread.status, replies: thread.reply_count },
          )
        : unknown('Comment thread unavailable')
    },
  },
  download: {
    commands: ['download'],
    seed: ['site'],
    prompt: ({ url }) =>
      `Download the static site shared at ${url} into a folder named out in the current directory.`,
    probe: async ({ workdir }) => ({
      download: await siteFilesIn(join(workdir, 'out')),
    }),
    verify: ({ download }) =>
      decide(
        download.some(
          (file) =>
            file.name === 'index.html' && file.text.includes('Status site'),
        ),
        { files: download.map((file) => file.path) },
      ),
  },
  site: {
    commands: ['share'],
    seed: [],
    files: siteFiles,
    prompt: () =>
      'Share the site folder as a static site with Artifact Share and give me its browser URL.',
    verify: ({ created }) =>
      created
        ? decide(
            created.length === 1 && created[0].artifact_kind === 'static_site',
            created.map((artifact) => artifact.artifact_kind),
          )
        : unknown('Artifact inventory unavailable'),
  },
  config: {
    commands: ['config'],
    seed: [],
    prompt: () =>
      'From now on, my new Artifact Share home posts should be private by default. Make that my personal setting only, not a repository policy. Do not share anything.',
    probe: async ({ cli }) => ({
      config: {
        user: await cli([
          'config',
          'get',
          'home_audience',
          '--scope',
          'user',
          '--json',
        ]),
        repository: await cli([
          'config',
          'get',
          'home_audience',
          '--scope',
          'repository',
          '--json',
        ]),
      },
    }),
    verify: ({ config, created }) => {
      const value = (output) => {
        try {
          return JSON.parse(output).data?.home_audience?.value ?? null
        } catch {
          return undefined
        }
      }
      const user = value(config.user)
      const repository = value(config.repository)
      return user === undefined
        ? unknown('Config output unavailable')
        : decide(
            user === 'private' && repository !== 'private' && !created?.length,
            {
              user,
              repository,
            },
          )
    },
  },
  whoami: {
    commands: ['whoami', 'doctor'],
    seed: [],
    prompt: () =>
      'Which Artifact Share account is this CLI signed in as? Tell me the email address.',
    verify: ({ record, email }) =>
      decide(record.finalMessage.includes(email), {
        finalMessage: record.finalMessage.slice(0, 200),
      }),
  },
}
// Commands an unattended run cannot exercise without affecting the shared
// credential, the user's installed skills, or an interactive browser.
export const excludedCommands = {
  login: 'Browser device authorization',
  logout: 'Revokes the credential every run shares',
  profiles: 'Changes saved profile selection outside the run',
  skills: 'Installs skills, which the run reports as contamination',
  init: 'Installs skills, which the run reports as contamination',
  changelog: 'Reads static release notes only',
  preview: 'Long-running local server that waits for browser feedback',
  move: 'Covered by the project scenario, which accepts edit or move',
}
export const scenarioIds = Object.keys(scenarios)
export const legacyScenarioIds = scenarioIds.filter(
  (id) => scenarios[id].legacy,
)

async function siteFilesIn(root) {
  const files = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.html'))
        files.push({
          path,
          name: entry.name,
          text: await readFile(path, 'utf8'),
        })
    }
  }
  await walk(root)
  return files
}
