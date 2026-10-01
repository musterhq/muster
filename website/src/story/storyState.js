// One hypothetical developer requirement throughout the marketing story.
// No messages, agents, repository operations or external accounts are connected.
export const requirement = {
  title: 'Add CSV export to the dashboard',
  request: 'Can we export the filtered dashboard rows as a CSV?',
  instruction: '@Muster take this on. Keep the filters, add tests, and show the result before review.',
  project: 'Dashboard',
  repository: 'dashboard',
  branch: 'feat/csv-export',
  acceptance: ['Export only the filtered rows', 'Include clear column headings', 'Validate the file in the browser', 'Open a reviewable pull request'],
};
export const dashboardRows = [
  {project:'Website',owner:'Frontend',status:'Ready'},
  {project:'Dashboard',owner:'QA',status:'In review'},
  {project:'Docs',owner:'Review',status:'Ready'},
];
export const chapterStories = [
  {id:'signal',eyebrow:'YOUR WORK, ASSEMBLED',title:'A requirement. A team. A reviewed change.',problem:'A good idea is only the start. The work needs an owner, project context and a result you can inspect.',action:'Follow one requirement from the chat thread to a code change and a review link.',outcome:'See who is doing what, what was checked and what still needs you.'},
  {id:'conversation',eyebrow:'BRING MUSTER IN',title:'The request is already in Slack.',problem:'A teammate asks for CSV export in #product-development. The conversation has context, but the work has no owner yet.',action:'A human tags Muster, adds the constraints and gives the work a clear starting point.',outcome:'The Slack thread stays the starting point. Muster picks up the work in its own project workspace.'},
  {id:'orchestration',eyebrow:'GIVE THE WORK OWNERS',title:'One request becomes a visible plan.',problem:'Implementation, testing and review need different kinds of work. A stack of prompts hides the dependencies.',action:'CEO receives the requirement, delegates to CTO and Designer, and lets CTO hand validation to QA.',outcome:'Open a task or profile to see progress, dependencies and the output being produced.'},
  {id:'memory',eyebrow:'INSIDE THE AGENT',title:'Context changes the next action.',problem:'“Export CSV” is not enough. The export must preserve filters and use the current dashboard columns.',action:'The agent uses the project notes, its task and available tools to form a concrete patch.',outcome:'Inspect the supporting context and the actions taken, rather than guessing from a spinner.'},
  {id:'code',eyebrow:'MAKE THE CHANGE CHECKABLE',title:'A plausible patch can still be wrong.',problem:'An export that ignores active filters would pass a casual glance and fail the requirement.',action:'Inspect the diff, run the check, expose the blocker and correct the row source.',outcome:'The changed code and the test result become evidence for review.'},
  {id:'connections',eyebrow:'WATCH THE RESULT',title:'Use the browser. Inspect the change.',problem:'Passing code checks does not show what the user experiences.',action:'The agent filters the dashboard, exports the CSV and checks its rows. The pull request opens in the right-hand pane.',outcome:'The result, validation and review link stay visible together.'},
  {id:'begin',eyebrow:'CLOSE THE LOOP',title:'The conversation gets a useful answer.',problem:'The person who asked should not have to hunt through agent activity to find the result.',action:'Muster replies in the original Slack thread with a concise summary and the pull-request link.',outcome:'The user knows what changed, what was checked and what needs review.'},
];
