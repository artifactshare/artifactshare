// Search input chrome shared by the home toolbar, the project list toolbar, and
// the move dialog. Consumers layer width/margin overrides on top via cn().
export const searchFieldClassName =
  'flex h-7 flex-1 items-center gap-1.5 rounded-[var(--r-sm)] border border-divider bg-muted px-2.5 text-muted-foreground max-w-80 ml-2 ' +
  'focus-within:border-border-strong focus-within:bg-card ' +
  '[&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:font-[inherit] [&_input]:text-sm [&_input]:text-foreground [&_input]:outline-0 ' +
  '[&_input::-webkit-search-cancel-button]:appearance-none ' +
  'max-stack:ml-0 max-stack:max-w-none max-stack:basis-full'
