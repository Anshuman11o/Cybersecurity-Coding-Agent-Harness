/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseXmlString } from '../../lib/xml'

void describe('xml', () => {
  void it('should parse a simple XML string', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><root>hello</root>'
    const result = await parseXmlString(xml)
    assert.match(result, /<root>hello<\/root>/)
  })


  void it('should throw error on malformed XML', async () => {
    const xml = '<root>unclosed'
    await assert.rejects(async () => {
      await parseXmlString(xml)
    })
  })

})
