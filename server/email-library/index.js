// Email library manifest. The "New Email" modal pulls its options from
// this file until the org-scoped Supabase tables ship. The block HTML lives
// alongside in sibling .html files (slot-style templates with
// `{{variable}}` placeholders). The base HTML is the 207 template shell.
//
// Adding a new block: drop hbXX.html in this dir, add an entry to BLOCKS.

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(__dirname, f), 'utf8')

export const BASE_TEMPLATE = {
  id: 'david-z-test',
  name: 'david-z-test',
  description: 'Default email wrapper with header + main content slots.',
  html: read('base-v4.2.html'),
  slots: ['main'] // header slot exists but is edited in SFMC
}

export const BLOCKS = [
  {
    id: 'HB10',
    name: 'Card Art',
    description: 'Card image on colored background, headline, CTA button.',
    variables: [
      { key: 'background_image_url', label: 'Background image URL', type: 'url', default: 'https://placehold.co/620x155.png' },
      { key: 'background_color', label: 'Background color', type: 'color', default: '#00175a' },
      { key: 'card_image_url', label: 'Card image URL', type: 'url', default: 'https://placehold.co/250x133.png' },
      { key: 'card_image_alt', label: 'Card image alt text', type: 'text', default: 'Card' },
      { key: 'headline', label: 'Headline', type: 'text', default: 'Headline goes here' },
      { key: 'button_label', label: 'Button label', type: 'text', default: 'Learn more' },
      { key: 'button_url', label: 'Button URL', type: 'url', default: 'https://example.com' }
    ],
    html: read('hb10.html')
  },
  {
    id: 'HB11',
    name: 'Text with Background Graphic',
    description: 'Full-width background image with headline, two paragraphs, and CTA.',
    variables: [
      { key: 'background_image_url', label: 'Background image URL', type: 'url', default: 'https://placehold.co/620x317.png' },
      { key: 'headline', label: 'Headline', type: 'text', default: 'Headline goes here' },
      { key: 'body_1', label: 'Paragraph 1', type: 'textarea', default: 'Opening paragraph text.' },
      { key: 'body_2', label: 'Paragraph 2', type: 'textarea', default: 'Follow-up sentence.' },
      { key: 'button_label', label: 'Button label', type: 'text', default: 'Learn more' },
      { key: 'button_url', label: 'Button URL', type: 'url', default: 'https://example.com' }
    ],
    html: read('hb11.html')
  },
  {
    id: 'HB12',
    name: 'Member Since Ribbon',
    description: 'Welcome headline, member name, and Member Since year.',
    variables: [
      { key: 'greeting_headline', label: 'Greeting headline', type: 'text', default: 'Welcome' },
      { key: 'member_name', label: 'Member name', type: 'text', default: 'Maya Campbell' },
      { key: 'member_since_year', label: 'Member since year', type: 'text', default: '2019' }
    ],
    html: read('hb12.html')
  },
  {
    id: 'HB14',
    name: 'Icon with Text',
    description: 'Small icon beside a headline, body paragraph, and CTA.',
    variables: [
      { key: 'icon_image_url', label: 'Icon image URL', type: 'url', default: 'https://placehold.co/80x80.png' },
      { key: 'headline', label: 'Headline', type: 'text', default: 'Headline goes here' },
      { key: 'body', label: 'Body paragraph', type: 'textarea', default: 'Supporting copy goes here.' },
      { key: 'button_label', label: 'Button label', type: 'text', default: 'Learn more' },
      { key: 'button_url', label: 'Button URL', type: 'url', default: 'https://example.com' }
    ],
    html: read('hb14.html')
  }
]

export const BLOCKS_BY_ID = Object.fromEntries(BLOCKS.map(b => [b.id, b]))

// Simple handlebars-ish substitution — replaces {{key}} anywhere in str.
// HTML-escapes values by default since blocks render user-supplied text.
// URL-typed variables are NOT escaped (they go in href/src).
export function renderBlock(block, vars = {}) {
  let out = block.html
  for (const v of block.variables) {
    const raw = vars[v.key] ?? v.default ?? ''
    const val = v.type === 'url' || v.type === 'color' ? String(raw) : escapeHtml(String(raw))
    out = out.replaceAll(`{{${v.key}}}`, val)
  }
  return out
}

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
