import type { Product as ProductConfig } from '../../../lib/config.schema'

describe('/#/contact', () => {
  beforeEach(() => {
    cy.visit('/#/contact')
    solveNextCaptcha()
  })

  describe('challenge "forgedFeedback"', () => {
    beforeEach(() => {
      cy.login({ email: 'admin', password: 'admin123' })
      cy.visit('/#/contact')
      solveNextCaptcha()
    })

  })

  describe('challenge "persistedXssFeedback"', () => {
    beforeEach(() => {
      cy.login({ email: 'admin', password: 'admin123' })
      cy.visit('/#/contact')
      solveNextCaptcha()
    })

    // Cypress alert bug
    // The challenge also passes but its just that cypress freezes and is unable to perform any action
    xit('should be possible to trick the sanitization with a masked XSS attack', () => {
      cy.task('isDocker').then((isDocker) => {
        if (!isDocker) {
          cy.get('#rating').type('{rightarrow}{rightarrow}{rightarrow}')
          cy.get('#comment').type(
            '<<script>Foo</script>iframe src="javascript:alert(`xss`)">'
          )
          cy.get('#submitButton').should('not.be.disabled').click()

          cy.visit('/#/about')
          cy.on('window:alert', (t) => {
            expect(t).to.equal('xss')
          })

          cy.visit('/#/administration')
          cy.on('window:alert', (t) => {
            expect(t).to.equal('xss')
          })
          cy.expectChallengeSolved({ challenge: 'Server-side XSS Protection' })
        }
      })
    })
  })

  describe('challenge "vulnerableComponent"', () => {
  })

  describe('challenge "weirdCrypto"', () => {
  })

  describe('challenge "typosquattingNpm"', () => {
  })

  describe('challenge "typosquattingAngular"', () => {
  })

  describe('challenge "hiddenImage"', () => {
  })

  describe('challenge "zeroStars"', () => {
  })

  describe('challenge "captchaBypass"', () => {
  })

  describe('challenge "supplyChainAttack"', () => {
  })

  describe('challenge "dlpPastebinDataLeak"', () => {
  })
})

function solveNextCaptcha () {
  cy.get('#captcha')
    .should('be.visible')
    .invoke('text')
    .then((val) => {
      cy.get('#captchaControl').clear()
      // eslint-disable-next-line no-eval
      const answer = eval(val).toString()
      cy.get('#captchaControl').type(answer)
    })
}
