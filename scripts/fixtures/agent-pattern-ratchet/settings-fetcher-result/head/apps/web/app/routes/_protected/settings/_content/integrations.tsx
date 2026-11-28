export default function IntegrationsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const fetcher = useFetcher<typeof action>()
  useSettingsEntryChange(fetcher.reset)
  const [selected, setSelected] = useState<SlackConnectionListItem | null>(null)
  const [open, setOpen] = useState(false)
  const pending = fetcher.state !== 'idle'
  const result = pending ? undefined : fetcher.data
  useEffect(() => {
    if (result?.ok) setOpen(false)
  }, [result])
  const connections = result?.ok
    ? loaderData.connections.filter(
        (connection) => connection.id !== result.connectionId,
      )
    : loaderData.connections
  const { currentUserIsAdmin } = useOutletContext<SettingsLayoutContext>()
  const dialogRendered =
    open &&
    selected &&
    currentUserIsAdmin &&
    connections.some((connection) => connection.id === selected.id)
  return dialogRendered
}
