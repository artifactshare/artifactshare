// Fixed paths of a PDF version's virtual bundle on its sandbox origin. The
// sandbox Worker serves them; the viewer requests them from its own origin.
export const PDF_ORIGINAL_PATH = '/__as_pdf/original.pdf'
export const PDF_VIEWER_SCRIPT_PATH = '/__as_pdf/viewer.js'
export const PDF_VIEWER_STYLE_PATH = '/__as_pdf/viewer.css'
export const PDFJS_ASSET_PREFIX = '/__as_pdf/pdfjs/'
