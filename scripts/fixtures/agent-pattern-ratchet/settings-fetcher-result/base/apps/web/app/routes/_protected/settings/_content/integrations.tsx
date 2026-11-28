export default function IntegrationsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const [searchParams] = useSearchParams()
  const actionData = useActionData<typeof action>()
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null)
  const [selectedConnection, setSelectedConnection] =
    useState<SlackConnectionListItem | null>(null)
  const showConnectedBanner = searchParams.get('connected') === 'slack'
  const { locale, t } = useT()
  const { connections } = loaderData
  const { currentUserIsAdmin } = useOutletContext<SettingsLayoutContext>()
  const navigation = useNavigation()
  const pending = navigation.state !== 'idle'
  const pendingDisconnectId =
    navigation.formAction === '/settings/integrations' &&
    navigation.formData?.get('intent') === 'disconnect-slack'
      ? stringValue(navigation.formData.get('connectionId'))
      : null
  const submittedConnection =
    selectedConnection?.id === actionData?.connectionId
      ? selectedConnection
      : connections.find(
          (connection) => connection.id === actionData?.connectionId,
        )
  const dialogRendered =
    currentUserIsAdmin &&
    connections.some((connection) => connection.id === openConnectionId)
  return dialogRendered
}
