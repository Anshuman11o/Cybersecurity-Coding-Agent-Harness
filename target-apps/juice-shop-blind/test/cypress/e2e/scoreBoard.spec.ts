describe('/#/score-board', () => {
  describe('challenge "scoreBoard"', () => {
  })

  describe('challenge "continueCode"', () => {
  })
})

xdescribe('/#/score-board-legacy', () => { // TODO Replace with test based on new Score Board
  describe('repeat notification', () => {
    beforeEach(() => {
      cy.visit('/#/score-board-legacy')
    })

    it('should be possible in both when and when not in CTF mode', () => {
      cy.task('GetFromConfig', 'challenges.showSolvedNotifications').as(
        'showSolvedNotifications'
      )
      cy.task('GetFromConfig', 'ctf.showFlagsInNotifications').as(
        'showFlagsInNotifications'
      )

      cy.get('@showSolvedNotifications').then((showSolvedNotifications) => {
        cy.get('@showFlagsInNotifications').then((showFlagsInNotifications) => {
          if (showSolvedNotifications && showFlagsInNotifications) {
            cy.get('.challenge-solved-toast').then((arrayOfSolvedToasts) => {
              const alertsBefore = Cypress.$(arrayOfSolvedToasts).length
              cy.get('[id="Score Board.solved"]').click()

              cy.get('.challenge-solved-toast').should(
                'not.have.length',
                alertsBefore
              )
            })
          } else {
            cy.get('.challenge-solved-toast').then((arrayOfSolvedToasts) => {
              const alertsBefore = Cypress.$(arrayOfSolvedToasts).length
              cy.get('[id="Score Board.solved"]').click()

              cy.get('.challenge-solved-toast').should(
                'have.length',
                alertsBefore
              )
            })
          }
        })
      })
    })
  })
})
