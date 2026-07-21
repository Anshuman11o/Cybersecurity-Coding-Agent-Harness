describe('/#/forgot-password', () => {
  beforeEach(() => {
    cy.get('body').then(($body) => {
      if ($body.find('#logout').length) {
        cy.get('#logout').click()
      }
    })
    cy.visit('/#/forgot-password')
    cy.intercept('GET', '/rest/user/security-question?email=*').as('securityQuestion')
  })

  describe('as Jim', () => {
  })

  describe('as Bender', () => {
  })

  describe('as Bjoern', () => {
    describe('for his internal account', () => {
    })

    describe('for his OWASP account', () => {
    })
  })

  describe('as Morty', () => {
  })

  describe('as Uvogin', () => {
  })
})
