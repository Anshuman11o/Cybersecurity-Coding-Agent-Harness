describe('/#/complain', () => {
  beforeEach(() => {
    cy.login({
      email: 'admin',
      password: 'admin123'
    })

    cy.visit('/#/complain')
  })

  describe('challenge "uploadSize"', () => {
  })

  describe('challenge "uploadType"', () => {
  })

  describe('challenge "deprecatedInterface"', () => {
  })

  describe('challenge "xxeFileDisclosure"', () => {


  })

  describe('challenge "xxeDos"', () => {


    xit('should be solved either through dev/random or Quadratic Blowup attack', () => { // FIXME Unreliable during CI/CD as sometimes the Quadratic Blowup is blocked for entity loops
      cy.task('isDocker').then((isDocker) => {
        if (!isDocker) {
          cy.expectChallengeSolved({ challenge: 'XXE DoS' })
        }
      })
    })
  })

  describe('challenge "yamlBomb"', () => {
  })

  describe('challenge "arbitraryFileWrite"', () => {
  })

  describe('challenge "videoXssChallenge"', () => {
  })
})
