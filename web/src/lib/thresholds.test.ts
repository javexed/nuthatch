import { describe, expect, it } from 'vitest'
import { alerts, level } from './thresholds'

describe('thresholds', () => {
  it('reads the forms plugins write', () => {
    expect([alerts(5, '10'), alerts(11, '10'), alerts(-1, '10')]).toEqual([false, true, true])
    expect([alerts(9, '10:'), alerts(10, '10:')]).toEqual([true, false])
    expect([alerts(-50, '~:10'), alerts(11, '~:10')]).toEqual([false, true])
    expect([alerts(4, '5:10'), alerts(7, '5:10'), alerts(11, '5:10')]).toEqual([true, false, true])
    expect([alerts(7, '@5:10'), alerts(4, '@5:10')]).toEqual([true, false])
    expect([alerts(1e9, ''), alerts(1, 'nonsense')]).toEqual([false, false])
  })
  it('critical before warning', () => {
    expect([level(50, '80', '90'), level(85, '80', '90'), level(95, '80', '90')]).toEqual([0, 1, 2])
  })
})
