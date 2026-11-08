// Fixed paths of a video version's virtual bundle on its sandbox origin. The
// sandbox Worker serves them; the player requests them from its own origin.
export const VIDEO_ORIGINAL_PATH = '/__as_video/original.mp4'
export const VIDEO_PLAYER_SCRIPT_PATH = '/__as_video/viewer.js'
export const VIDEO_PLAYER_STYLE_PATH = '/__as_video/viewer.css'

export const VIDEO_PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const
