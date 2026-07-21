import { type Product } from '../../../data/types'

describe('/#/search', () => {
  beforeEach(() => {
    cy.visit('/#/search')
  })
  describe('challenge "localXss"', () => {
    // Cypress alert bug
    xit('search query should be susceptible to reflected XSS attacks', () => {
      cy.get('#searchQuery').click()
      cy.get('app-mat-search-bar input')
        .type('<iframe src="javascript:alert(`xss`)">')
        .type('{enter}')
      cy.on('window:alert', (t) => {
        expect(t).to.equal('xss')
      })
      cy.expectChallengeSolved({ challenge: 'DOM XSS' })
    })
  })
  describe('challenge "xssBonusPayload"', () => {
  })
})

describe('/rest/products/search', () => {
  describe('challenge "unionSqlInjection"', () => {
  })

  describe('challenge "dbSchema"', () => {
  })

  describe('challenge "dlpPastebinLeakChallenge"', () => {
    beforeEach(() => {
      cy.login({
        email: 'admin',
        password: 'admin123'
      })
    })

  })

  xdescribe('challenge "christmasSpecial"', () => {
    beforeEach(() => {
      cy.login({
        email: 'admin',
        password: 'admin123'
      })
    })


  })
})
