import { cva } from 'class-variance-authority'

const layoutGaps = [
  '0',
  '0.5',
  '1',
  '1.5',
  '2',
  '3',
  '4',
  '5',
  '6',
  '8',
  '10',
  '12',
  '16',
  '20',
  '24',
] as const

export type LayoutGap = (typeof layoutGaps)[number]

const layoutAligns = ['start', 'center', 'end', 'stretch', 'baseline'] as const

export type LayoutAlign = (typeof layoutAligns)[number]

const layoutJustifies = [
  'start',
  'center',
  'end',
  'between',
  'around',
  'evenly',
] as const

export type LayoutJustify = (typeof layoutJustifies)[number]

const gapVariants = {
  '0': 'gap-0',
  '0.5': 'gap-0.5',
  '1': 'gap-1',
  '1.5': 'gap-1.5',
  '2': 'gap-2',
  '3': 'gap-3',
  '4': 'gap-4',
  '5': 'gap-5',
  '6': 'gap-6',
  '8': 'gap-8',
  '10': 'gap-10',
  '12': 'gap-12',
  '16': 'gap-16',
  '20': 'gap-20',
  '24': 'gap-24',
} as const satisfies Record<LayoutGap, string>

const alignVariants = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
  baseline: 'items-baseline',
} as const satisfies Record<LayoutAlign, string>

const justifyVariants = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
  evenly: 'justify-evenly',
} as const satisfies Record<LayoutJustify, string>

export const stackLayoutVariants = cva('flex flex-col', {
  variants: {
    gap: gapVariants,
    align: alignVariants,
    justify: justifyVariants,
    wrap: {
      true: 'flex-wrap',
      false: '',
    },
  },
  defaultVariants: {
    wrap: false,
  },
})

export const inlineLayoutVariants = cva('flex flex-row', {
  variants: {
    gap: gapVariants,
    align: alignVariants,
    justify: justifyVariants,
    wrap: {
      true: 'flex-wrap',
      false: '',
    },
  },
  defaultVariants: {
    wrap: false,
  },
})
