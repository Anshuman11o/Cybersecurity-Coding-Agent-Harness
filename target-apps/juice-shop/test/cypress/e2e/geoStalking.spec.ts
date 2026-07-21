describe('/#/photo-wall', () => {
  beforeEach(() => {
    cy.visit('/#/forgot-password')
    cy.intercept('GET', '/rest/user/security-question?email=*').as('securityQuestion')
  })

  describe('challenge "geoStalkingMeta"', () => {
  })

  describe('challenge "geoStalkingVisual"', () => {
  })
})
