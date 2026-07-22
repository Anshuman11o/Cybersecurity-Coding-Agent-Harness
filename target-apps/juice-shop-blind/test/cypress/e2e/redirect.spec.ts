describe('/redirect', () => {
  describe('challenge "redirect"', () => {
    it('should show error page when supplying an unrecognized target URL', () => {
      cy.visit('/redirect?to=http://kimminich.de', {
        failOnStatusCode: false
      })
      cy.contains('Unrecognized target URL for redirect: http://kimminich.de')
    })
  })

  describe('challenge "redirect"', () => {
  })

  describe('challenge "redirectCryptoCurrency"', () => {
  })
})
