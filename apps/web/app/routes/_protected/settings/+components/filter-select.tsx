import { useState } from 'react'
import { Field, FieldLabel } from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'

export function FilterSelect({
  id,
  name,
  label,
  initialValue,
  options,
  className,
}: {
  id: string
  name: string
  label: string
  initialValue: string
  options: Record<string, string>
  className: string
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <Field className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select name={name} value={value} onValueChange={setValue}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{options[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {Object.entries(options).map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
