export const MAINTENANCE_REQUEST_HEADER = 'x-artifactshare-maintenance'

export function isMaintenanceRequest(request: Request): boolean {
  return request.headers.get(MAINTENANCE_REQUEST_HEADER) === '1'
}
