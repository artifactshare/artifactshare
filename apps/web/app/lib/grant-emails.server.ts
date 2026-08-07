import { sql, type RawBuilder } from 'kysely'

// granted_email / users.email を SQL で照合するときは、入力側だけでなく保存値側も
// 小文字化する。書き込みは normalizeGrantEmail で小文字化するが小文字であることは
// DB 制約では保証されないため、保存値を素のまま比較すると大文字混じりの保存行を
// 取りこぼすため、照合は必ずこのヘルパを通す。
export function lowerEmail(column: string): RawBuilder<string> {
  return sql<string>`lower(${sql.ref(column)})`
}
