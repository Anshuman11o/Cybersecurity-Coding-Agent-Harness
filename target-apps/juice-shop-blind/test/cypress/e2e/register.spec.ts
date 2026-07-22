describe('/#/register', () => {
  beforeEach(() => {
    cy.visit('/#/register')
  })

  describe('challenge "persistedXssUser"', () => {
    beforeEach(() => {
      cy.login({
        email: 'admin',
        password: 'admin123'
      })
    })

  })

  describe('challenge "registerAdmin"', () => {
  })

  describe('challenge "passwordRepeat"', () => {
  })

  describe('challenge "registerEmptyUser"', () => {
  })
})
